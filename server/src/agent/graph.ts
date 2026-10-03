import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { addTimeline, EVENT_LABELS, hasConsent, supersedePendingActions } from '../caseStore';
import {
  calculateEmiShortfall,
  computeEmiDecision,
  computeHumanOnlyDecision,
  computeUpiDecision,
  formatDay,
  formatInr,
  parseStatedAmount,
  plural,
} from '../decision';
import {
  computeHospitalDecision,
  type HospitalBillInput,
  type HospitalInsuranceInput,
  type SourcedValue,
} from '../hospitalDecision';
import {
  fixtures,
  PARTNERS,
  type AffordabilityRules,
  type FinancialProfile,
  type LenderOffer,
  type LoanContext,
} from '../fixtures';
import { GatewayError } from '../mcp/errors';
import { invokeTool } from '../mcp/gateway';
import { recordAudit } from '../db';
import type {
  AgentNodeId,
  AgentTrigger,
  CaseRecord,
  EvidencePassage,
  Playbook,
  Principal,
  Slot,
  SlotSource,
  SourceRef,
  Transaction,
} from '../types';
import { consentNeededMessage, detectLanguage, explainDecision, pickTransactionMessage } from './explainer';
import { sarvamAvailable } from '../config';
import { translateWithSarvam } from '../integrations';
import { runDeclarativeDecision } from '../playbooks/declarative';
import { classifyWithPlaybooks, playbookForCase } from '../playbooks/registry';
import type { CoverageAssessment } from '../coverage';
import { householdContext } from '../insurance';
import { addLocalizedMessage } from './localize';
import { RunTracer } from './trace';

const READ_CONSENT = 'prepare_resolution_options' as const;

interface Coverage {
  estimated_coverage_inr: number;
  assessment: CoverageAssessment;
  clause_id: string;
  page: number;
  confidence: number;
  policy_document_id: string;
  policy_file_name: string;
  assumptions: { clause_id: string; page: number; title: string }[];
}

// Facts gathered by earlier nodes for later ones. Plain JSON so the state stays serializable.
interface Gathered {
  profile?: FinancialProfile;
  clauses?: EvidencePassage[];
  coverage?: Coverage;
  playbook?: Playbook | null;
  transaction?: Transaction;
  loans?: LoanContext;
}

const AgentState = Annotation.Root({
  trigger: Annotation<AgentTrigger>(),
  grant_consent: Annotation<boolean>(),
  transaction_id: Annotation<string | null>(),
  gathered: Annotation<Gathered>({ reducer: (current, update) => ({ ...current, ...update }), default: () => ({}) }),
  paused: Annotation<string | null>(),
  error: Annotation<string | null>(),
  visited: Annotation<AgentNodeId[]>({ reducer: (current, update) => current.concat(update), default: () => [] }),
});

type State = typeof AgentState.State;
type Update = Partial<typeof AgentState.Update>;

export interface RunContext {
  record: CaseRecord;
  principal: Principal;
  tracer: RunTracer;
  grantConsent?: () => void;
}

type NodeResult = { update?: Update; summary: string; paused?: string };

function contextOf(config: LangGraphRunnableConfig): RunContext {
  const context = config.configurable?.saathi as RunContext | undefined;
  if (!context) throw new Error('Agent graph invoked without a Saathi run context.');
  return context;
}

function callTool<T>(context: RunContext, tool: string, input: Record<string, unknown> = {}): Promise<T> {
  context.tracer.tool(tool);
  return invokeTool<T>(tool, { case_id: context.record.case_id, ...input }, { principal: context.principal, caseRecord: context.record });
}

// Wraps a node so every step is traced and any failure routes to human review instead of throwing.
function node(id: AgentNodeId, run: (state: State, context: RunContext) => NodeResult | Promise<NodeResult>) {
  return async (state: State, config: LangGraphRunnableConfig): Promise<Update> => {
    const context = contextOf(config);
    context.tracer.begin(id);
    try {
      const result = await run(state, context);
      context.tracer.end(result.paused ? 'paused' : 'ok', result.summary);
      return { ...result.update, paused: result.paused ?? null, visited: [id] };
    } catch (error) {
      const reason = error instanceof GatewayError || error instanceof Error ? error.message : 'Unknown error';
      context.tracer.end('error', reason);
      return { error: reason, visited: [id] };
    }
  };
}

// Only the fields the insurer contract accepts.
function billLines(lines: { line: number; description: string; amount_inr: number; days?: number; non_medical_inr?: number }[]) {
  return lines.map(({ line, description, amount_inr, days, non_medical_inr }) => ({
    line,
    description: description.slice(0, 120),
    amount_inr,
    ...(days ? { days } : {}),
    ...(non_medical_inr !== undefined ? { non_medical_inr } : {}),
  }));
}

function playbookPassage(playbook: Playbook): EvidencePassage {
  return {
    document_id: playbook.playbook_id,
    document_name: playbook.source,
    document_type: 'playbook',
    page: 1,
    title: playbook.title,
    text: playbook.steps.map((step, index) => `${index + 1}. ${step}`).join(' '),
    score: 1,
  };
}

// Messages in Indic scripts are translated to English for the keyword rules only; the original stays the customer's words.
async function rulesText(record: CaseRecord): Promise<string> {
  if (!/[^\u0000-\u024f\s\d.,!?₹'"()-]/.test(record.customer_message) || !sarvamAvailable()) return record.customer_message;
  try {
    return `${record.customer_message} ${await translateWithSarvam(record.customer_message, 'en-IN')}`;
  } catch {
    return record.customer_message;
  }
}

const classifier = node('classifier', async (_state, context) => {
  const { record } = context;
  // The conversation pipeline already understood the request; only uncategorised cases are classified here.
  if (!record.playbook_id) {
    const text = await rulesText(record);
    if (text !== record.customer_message) record.message_for_rules = text;
    const classification = classifyWithPlaybooks(text);
    record.playbook_id = classification.playbook.id;
    record.event_type = classification.event_type;
    record.urgency = classification.urgency;
  }
  record.language = record.preferred_language ? 'en' : (record.language ?? detectLanguage(record.customer_message));
  addTimeline(record, {
    status: 'intake',
    title: 'Case opened',
    detail: `Classified as ${EVENT_LABELS[record.event_type]} (${record.urgency} urgency).`,
    actor: 'saathi',
  });
  recordAudit({ case_id: record.case_id, actor: context.principal.sub, event: 'case_created', detail: { event_type: record.event_type } });
  const playbook = playbookForCase(record);
  return {
    summary: `${EVENT_LABELS[record.event_type]}, ${record.urgency} urgency, language ${record.language}; playbook ${playbook.id} v${playbook.version} (${playbook.engine}).`,
  };
});

const consentGate = node('consent_gate', async (state, { record, grantConsent }) => {
  if (state.grant_consent && !hasConsent(record, READ_CONSENT)) grantConsent?.();
  if (hasConsent(record, READ_CONSENT)) return { summary: 'Consent "prepare resolution options" is active.' };
  if (state.trigger === 'intake') await addLocalizedMessage(record, consentNeededMessage(record.language));
  return { summary: 'No consent yet; nothing was read.', paused: 'awaiting_consent' };
});

const contextRetriever = node('context_retriever', async (state, context) => {
  const { record } = context;
  if (state.trigger !== 'documents_updated') {
    addTimeline(record, {
      status: 'understand',
      title: 'Understanding the event',
      detail:
        record.event_type === 'hospitalization'
          ? record.context?.records
            ? 'Hospital bill, high urgency. Using your insurer, hospital and bank records (read with your consent) and what you told Saathi.'
            : 'Hospital bill, high urgency. Using the amounts from this conversation and loading your cash context through the MCP gateway.'
          : record.event_type === 'upi_dispute'
            ? 'Possible unrecognized UPI debit. Loading recent debits through the payments MCP.'
            : `${EVENT_LABELS[record.event_type]}, ${record.urgency} urgency.`,
      actor: 'saathi',
    });
  }
  if (record.event_type === 'general_financial_support') return { summary: 'No account context needed for a specialist route.' };
  const profile = await callTool<FinancialProfile>(context, 'payments.get_balance');
  let aaNote = '';
  if (playbookForCase(record).tools.read.includes('aa.fetch_fi_data')) {
    const consent = await callTool<{ consent_handle: string }>(context, 'aa.request_consent', {
      purpose: 'prepare_resolution_options',
      fi_types: ['DEPOSIT'],
    });
    const fi = await callTool<{ avg_monthly_inflow_inr: number; months_analysed: number }>(context, 'aa.fetch_fi_data', {
      consent_handle: consent.consent_handle,
    });
    aaNote = ` AA consent ${consent.consent_handle}: ${formatInr(fi.avg_monthly_inflow_inr)} average monthly inflow over ${fi.months_analysed} months.`;
  }
  return {
    update: { gathered: { profile } },
    summary: `Account context loaded: ${formatInr(profile.emergency_savings_inr)} savings, ${formatInr(profile.monthly_income_inr)} monthly income.${aaNote}`,
  };
});

const policyRag = node('policy_rag', async (_state, context) => {
  const { record } = context;
  if (record.event_type !== 'hospitalization') {
    const playbook = await callTool<Playbook | null>(context, 'knowledge.search_playbook', { event_type: record.event_type });
    return { update: { gathered: { playbook } }, summary: playbook ? `Playbook ${playbook.playbook_id}: ${playbook.title}.` : 'No playbook found.' };
  }
  if (!needsInsurerEstimate(record)) {
    return { summary: 'No policy lookup needed: insurance is taken from what the customer said (or not counted).' };
  }
  await callTool(context, 'insurer.get_policy');
  const clauses = await callTool<EvidencePassage[]>(context, 'knowledge.search_policy', {
    query: 'hospital inpatient claim room bill documents',
    top_k: 5,
  });
  return {
    update: { gathered: { clauses } },
    summary: `Insurer estimate needed for the confirmed bill; cited clauses ${clauses.map((clause) => clause.clause_id).join(', ')}.`,
  };
});

const SLOT_SOURCE_TYPE: Record<SlotSource, SourceRef['type']> = {
  customer_statement: 'customer_statement',
  customer_choice: 'customer_statement',
  uploaded_document: 'bill_line',
  account_records: 'customer_profile',
  insurer_estimate: 'policy_clause',
  insurer_record: 'policy_clause',
  hospital_record: 'bill_line',
};

function sourced(slot: Slot<number>): SourcedValue {
  return {
    value: slot.value,
    source: { type: SLOT_SOURCE_TYPE[slot.source], ref: slot.ref },
    confidence: slot.confidence,
    confirmed_by_customer: slot.source === 'customer_statement' || slot.source === 'customer_choice',
  };
}

// The hospital's own bill for the current admission, when that is the bill this plan uses.
function admissionBill(record: CaseRecord) {
  const admission = record.context?.records?.admission;
  return admission && record.confirmed_bill?.document_id === admission.document_id ? admission : null;
}

// The bill to plan for: a bill the customer uploaded and confirmed, otherwise the amount they told Saathi.
function hospitalBill(record: CaseRecord): HospitalBillInput | null {
  const confirmed = record.confirmed_bill;
  if (confirmed) {
    const range = confirmed.lines.length > 1 ? `Lines ${confirmed.lines[0]!.line}-${confirmed.lines.at(-1)!.line}` : 'Bill total';
    return {
      value: confirmed.total_inr,
      lines: confirmed.lines,
      document_id: confirmed.document_id,
      file_name: confirmed.document_name,
      source: { type: 'bill_line', ref: range, document: confirmed.document_name },
      confidence: 0.95,
      confirmed_by_customer: true,
    };
  }
  const slot = record.context?.slots.bill_inr;
  return slot ? { ...sourced(slot), lines: null, document_id: null, file_name: null } : null;
}

// The insurer is asked for an estimate only when the customer is insured, has a policy on file, did not state
// a cover amount, and there is an itemised bill (confirmed upload or the hospital's own record) to check.
function needsInsurerEstimate(record: CaseRecord): boolean {
  const slots = record.context?.slots;
  return Boolean(slots?.has_insurance?.value && !slots.insurance_cover_inr && record.confirmed_bill && record.context?.records?.policy);
}

function hospitalEvidence(record: CaseRecord, clauses: EvidencePassage[]) {
  const admission = admissionBill(record);
  const documents = record.uploaded_documents.map((document) => ({
    document_id: document.document_id,
    document_type: document.document_type,
    document_name: document.document_name,
    text: document.text.slice(0, 4000),
  }));
  if (admission) {
    documents.unshift({
      document_id: admission.document_id,
      document_type: 'bill',
      document_name: admission.document_name,
      text: [
        `${admission.hospital}: ${admission.patient} (${admission.relation}), ${admission.ward}. ${admission.reason}.`,
        ...admission.lines.map((line) => `Line ${line.line}: ${line.description} - ${formatInr(line.amount_inr)}`),
        `Total: ${formatInr(admission.total_inr)}`,
      ].join('\n'),
    });
  }
  return {
    demo_only: false,
    documents,
    retrieved_evidence: clauses,
    missing_documents: admission?.missing_documents ?? [],
    notice: admission
      ? 'Figures come from your insurer, the hospital and your bank through Saathi partner connections (simulated for this prototype). The insurer decides the final claim amount.'
      : clauses.length
        ? 'Figures come from this conversation and the bill you confirmed. The insurer decides the final claim amount.'
        : 'Figures come from what you told Saathi in this conversation. Upload a bill or policy to check them.',
  };
}

const billAuditor = node('bill_auditor', async (state, context) => {
  const { record } = context;
  const bill = hospitalBill(record);
  if (!bill) throw new Error('The bill amount is missing, so the gap cannot be calculated yet.');
  let coverage: Coverage | undefined;
  if (needsInsurerEstimate(record) && bill.lines) {
    coverage = await callTool<Coverage>(context, 'insurer.check_coverage', { bill_total_inr: bill.value, lines: billLines(bill.lines) });
  }
  const slots = record.context?.slots ?? {};
  const insurance = coverage
    ? `insurer estimate ${formatInr(coverage.estimated_coverage_inr)}`
    : slots.insurance_cover_inr
      ? `expected cover ${formatInr(slots.insurance_cover_inr.value)} (customer)`
      : 'no insurance counted';
  record.evidence = hospitalEvidence(record, state.gathered.clauses ?? []);
  addTimeline(record, {
    status: 'evidence_ready',
    title: 'Facts gathered',
    detail: `Bill ${formatInr(bill.value)} (${bill.file_name ?? 'as you told Saathi'}); ${insurance}.`,
    actor: 'saathi',
  });
  return {
    update: coverage ? { gathered: { coverage } } : {},
    summary: `Bill ${formatInr(bill.value)} from ${bill.file_name ?? 'the conversation'}; ${insurance}.`,
  };
});

const transactionAuditor = node('transaction_auditor', async (state, context) => {
  const { record } = context;
  const picker = playbookForCase(record).pick_transaction ?? {
    prompt: 'Which payment is this about?',
    mode: 'dispute' as const,
    filter: { direction: 'debit' as const },
    match_stated_amount: true,
  };
  if (!state.transaction_id) {
    const stated = picker.match_stated_amount
      ? (record.context?.slots.debit_inr?.value ?? parseStatedAmount(record.message_for_rules ?? record.customer_message))
      : null;
    let candidates = await callTool<Transaction[]>(context, 'payments.list_transactions', {
      ...picker.filter,
      limit: 5,
      ...(stated ? { amount_inr: stated } : {}),
    });
    if (!candidates.length && stated) {
      candidates = await callTool<Transaction[]>(context, 'payments.list_transactions', { ...picker.filter, limit: 5 });
    }
    record.pending_question = { type: 'confirm_transaction', prompt: picker.prompt, candidates, mode: picker.mode };
    addTimeline(record, { title: 'Waiting for you to pick the transaction', detail: `${plural(candidates.length, 'matching debit')}.`, actor: 'saathi' });
    await addLocalizedMessage(
      record,
      pickTransactionMessage(record.language, candidates.length, stated, Boolean(stated && candidates.some((candidate) => candidate.amount_inr === stated))),
    );
    return { summary: `${plural(candidates.length, 'candidate debit')}; waiting for the customer to pick one.`, paused: 'awaiting_transaction' };
  }

  const transaction = await callTool<Transaction>(context, 'payments.get_transaction', { transaction_id: state.transaction_id });
  const playbook = await callTool<Playbook | null>(context, 'knowledge.search_playbook', { event_type: record.event_type });
  record.evidence = {
    demo_only: false,
    documents: [],
    retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
    missing_documents: [],
    transaction,
    playbook,
    notice: 'Transaction details from your payment records. Dispute outcomes are decided by the bank and payment network.',
  };
  addTimeline(record, {
    status: 'evidence_ready',
    title: 'Evidence gathered',
    detail: `${transaction.counterparty}, ${transaction.channel}, ${transaction.device}.`,
    actor: 'saathi',
  });
  const signals = [
    !transaction.recognized_device && 'unrecognized device',
    transaction.first_time_counterparty && 'first-time payee',
    transaction.prior_payments_to_counterparty === 0 && 'no prior payments',
  ].filter(Boolean);
  return {
    update: { gathered: { transaction, playbook } },
    summary: `${formatInr(transaction.amount_inr)} to ${transaction.counterparty}; signals: ${signals.join(', ') || 'none'}.`,
  };
});

const emiAuditor = node('emi_auditor', async (state, context) => {
  const { record } = context;
  const loans = await callTool<LoanContext>(context, 'lending.get_loans');
  const loan = loans.loans[0];
  const playbook = state.gathered.playbook ?? null;
  record.evidence = {
    demo_only: false,
    documents: [],
    retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
    missing_documents: [],
    playbook,
    notice: 'Loan and salary details from your records and this conversation. The lender decides any change to your EMI.',
  };
  addTimeline(record, {
    status: 'evidence_ready',
    title: 'Evidence gathered',
    detail: loan
      ? `${loan.product} ${loan.loan_id}: EMI ${formatInr(loan.emi_inr)} due ${loan.next_due_date}; salary ${loans.salary.status}, expected ${loans.salary.expected_date}.`
      : 'No active loan or EMI on record.',
    actor: 'saathi',
  });
  return {
    update: { gathered: { loans } },
    summary: loan
      ? `EMI ${formatInr(loan.emi_inr)} due ${loan.next_due_date}; ${formatInr(loans.committed_before_due_inr)} already committed; salary ${loans.salary.status} to ${loans.salary.expected_date}.`
      : 'No active EMI found.',
  };
});

async function emiDecision(state: State, context: RunContext): Promise<string> {
  const { record } = context;
  const loans = state.gathered.loans ?? await callTool<LoanContext>(context, 'lending.get_loans');
  const loan = loans.loans[0];
  const playbook = state.gathered.playbook ?? null;
  if (!loan) {
    record.decision = computeHumanOnlyDecision({ eventType: record.event_type, urgency: record.urgency, playbook });
    record.decision.explanation = 'I could not find an active loan or EMI on your account, so a specialist will continue from your passport.';
    return 'No active EMI; specialist route';
  }
  const profile = state.gathered.profile ?? await callTool<FinancialProfile>(context, 'payments.get_balance');
  const { shortfall_inr: shortfall } = calculateEmiShortfall({
    emi_inr: loan.emi_inr,
    account_balance_inr: profile.account_balance_inr,
    committed_before_due_inr: loans.committed_before_due_inr,
  });
  const offerSet = shortfall > 0
    ? await callTool<{ offers: LenderOffer[]; rules: AffordabilityRules }>(context, 'lending.get_offers', { amount_inr: shortfall })
    : null;
  const { loans: _loans, ...recorded } = loans;
  const slots = record.context?.slots ?? {};
  // The customer knows their payday best; a date they gave replaces the payroll schedule on record.
  const loanContext = slots.salary_date
    ? {
        ...recorded,
        salary: {
          ...recorded.salary,
          expected_date: slots.salary_date.value,
          status: slots.salary_date.value > loan.next_due_date ? ('delayed' as const) : recorded.salary.status,
          source: 'What you told Saathi',
        },
      }
    : recorded;
  const notes: string[] = [];
  if (slots.emi_due_date && slots.emi_due_date.value !== loan.next_due_date) {
    notes.push(`You mentioned the EMI is due on ${formatDay(slots.emi_due_date.value)}; the lender's records show ${formatDay(loan.next_due_date)}, so Saathi plans for the lender's date.`);
  }
  if (slots.emi_inr && slots.emi_inr.value !== loan.emi_inr) {
    notes.push(`You mentioned an EMI of ${formatInr(slots.emi_inr.value)}; the lender's records show ${formatInr(loan.emi_inr)}.`);
  }
  record.decision = computeEmiDecision({
    caseId: record.case_id,
    urgency: record.urgency,
    loan,
    context: loanContext,
    profile,
    bridgeOffer: offerSet?.offers.find((offer) => offer.kind === 'bridge') ?? null,
    rules: offerSet?.rules ?? fixtures.lending.affordability_rules,
    lender: fixtures.loans.partner,
    playbook,
  });
  record.decision.warnings.push(...notes);
  return `Formula ${record.decision.formula_version}; shortfall ${formatInr(shortfall)}`;
}

// Customer uploads pause automated claim and credit steps unless the customer confirmed the bill figures
// or an assigned specialist verified the documents.
function verificationNeeded(record: CaseRecord): { required: boolean; reason?: string } {
  if (record.specialist?.verified_documents) return { required: false };
  const unconfirmed = record.uploaded_documents.filter(
    (document) => document.document_type === 'policy' || document.document_id !== record.confirmed_bill?.document_id,
  );
  if (!unconfirmed.length) return { required: false };
  return {
    required: true,
    reason: unconfirmed.some((document) => document.document_type === 'policy')
      ? 'You added your own policy. Saathi has not verified coverage from it, so claim and credit steps wait for a specialist.'
      : 'You added a bill that has not been confirmed yet. Confirm its total, or a specialist will verify it.',
  };
}

async function hospitalDecision(state: State, context: RunContext): Promise<string> {
  const { record } = context;
  const bill = hospitalBill(record);
  if (!bill) throw new Error('The bill amount is missing, so the gap cannot be calculated yet.');
  const slots = record.context?.slots ?? {};
  let insurance: HospitalInsuranceInput | null = null;
  let coverage: Coverage | undefined;
  if (slots.has_insurance?.value) {
    if (slots.insurance_cover_inr) {
      insurance = { ...sourced(slots.insurance_cover_inr), policy_document_id: null, policy_file_name: null, assumptions: [] };
    } else if (needsInsurerEstimate(record) && bill.lines) {
      coverage = state.gathered.coverage ?? await callTool<Coverage>(context, 'insurer.check_coverage', { bill_total_inr: bill.value, lines: billLines(bill.lines) });
      insurance = {
        value: coverage.estimated_coverage_inr,
        source: { type: 'policy_clause', ref: `Clause ${coverage.clause_id}, page ${coverage.page}`, document: coverage.policy_file_name },
        confidence: coverage.confidence,
        policy_document_id: coverage.policy_document_id,
        policy_file_name: coverage.policy_file_name,
        assumptions: coverage.assumptions,
      };
    } else {
      throw new Error('The expected insurance cover is missing, so the gap cannot be calculated yet.');
    }
  }
  const contribution: SourcedValue = slots.self_pay_inr
    ? sourced(slots.self_pay_inr)
    : { value: 0, source: { type: 'customer_statement', ref: 'No amount set aside yet' }, confidence: 1 };
  const profile = state.gathered.profile ?? await callTool<FinancialProfile>(context, 'payments.get_balance');
  const gap = Math.max(bill.value - Math.min(insurance?.value ?? 0, bill.value) - contribution.value, 0);
  const offerSets: { offers: LenderOffer[]; rules: AffordabilityRules }[] = [];
  for (const amount of [...new Set([gap, bill.value])].filter((value) => value > 0 && value <= 10_000_000)) {
    offerSets.push(await callTool<{ offers: LenderOffer[]; rules: AffordabilityRules }>(context, 'lending.get_offers', { amount_inr: amount }));
  }
  const offers = [...new Map(offerSets.flatMap((set) => set.offers).map((offer) => [offer.offer_id, offer])).values()];
  const admission = admissionBill(record);
  const flags = (coverage?.assessment.lines ?? [])
    .filter((line) => line.status === 'capped')
    .map(
      (line) =>
        `Room-rent cap (policy clause ${line.clause_id}): ${formatInr(line.not_payable_inr)} of "${line.description}" is above the daily room limit, so the insurer will not pay it.`,
    );

  record.decision = computeHospitalDecision({
    caseId: record.case_id,
    urgency: record.urgency,
    bill,
    insurance,
    contribution,
    profile,
    offers,
    rules: offerSets[0]?.rules ?? fixtures.lending.affordability_rules,
    partners: {
      insurer: PARTNERS.insurer,
      lender: PARTNERS.lender,
      hospital: admission ? `${admission.hospital} (simulated)` : PARTNERS.hospital,
    },
    statedBillInr: record.context?.stated_bill_inr ?? null,
    verification: verificationNeeded(record),
    missingDocuments: admission?.missing_documents ?? [],
    mutualFunds: record.context?.records?.cash?.mutual_funds ?? [],
    flags,
  });
  record.decision.coverage_breakdown = coverage?.assessment ?? null;
  if (record.context) record.context.gap = record.decision.calculation;
  return `Formula ${record.decision.formula_version}; bill ${formatInr(bill.value)}, cover ${formatInr(insurance?.value ?? 0)}, you pay ${formatInr(contribution.value)}; gap ${formatInr(record.decision.calculation?.exact_gap_inr ?? 0)}`;
}

const decision = node('decision', async (state, context) => {
  const { record } = context;
  supersedePendingActions(record, 'The options were recalculated, so any earlier approval request no longer applies.');
  let detail: string;
  const activePlaybook = playbookForCase(record);
  if (activePlaybook.engine === 'declarative') {
    const transaction = state.gathered.transaction;
    if (activePlaybook.pick_transaction && !transaction) throw new Error('No confirmed transaction to decide on.');
    record.decision = runDeclarativeDecision(activePlaybook, {
      caseId: record.case_id,
      urgency: record.urgency,
      context: { transaction: transaction ?? {}, profile: state.gathered.profile ?? {}, household: householdContext(record.customer_id) ?? {} },
      partner: PARTNERS.payments,
    });
    detail = `Declarative playbook ${activePlaybook.id} (${record.decision.formula_version})`;
  } else if (activePlaybook.engine === 'builtin:hospital_gap') {
    detail = await hospitalDecision(state, context);
  } else if (activePlaybook.engine === 'builtin:upi_dispute') {
    const transaction = state.gathered.transaction;
    if (!transaction) throw new Error('No confirmed transaction to decide on.');
    record.decision = computeUpiDecision({
      caseId: record.case_id,
      urgency: record.urgency,
      transaction,
      playbook: state.gathered.playbook ?? null,
      paymentsPartner: PARTNERS.payments,
    });
    detail = `Formula ${record.decision.formula_version}`;
  } else if (activePlaybook.engine === 'builtin:emi_shortfall') {
    detail = await emiDecision(state, context);
  } else {
    const playbook = state.gathered.playbook ?? null;
    record.evidence = {
      demo_only: false,
      documents: [],
      retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
      missing_documents: [],
      playbook,
      notice: 'A Saathi specialist handles this situation with you.',
    };
    record.decision = computeHumanOnlyDecision({ eventType: record.event_type, urgency: record.urgency, playbook });
    detail = 'Specialist route';
  }
  const decided = record.decision!;
  const best = decided.options.find((option) => option.recommended);
  addTimeline(record, {
    status: 'options_ready',
    title: 'Options compared',
    detail: best ? `Recommended: ${best.title} (${best.scores.total}/100). Formula ${decided.formula_version}.` : 'No safe automated option.',
    actor: 'saathi',
  });
  const feasible = decided.options.filter((option) => option.feasible).length;
  return { summary: `${detail}. ${feasible}/${decided.options.length} options pass guardrails; best: ${best?.title ?? 'none'}.` };
});

const explainer = node('explainer', async (_state, { record }) => {
  await addLocalizedMessage(record, explainDecision(record));
  const language = record.messages.at(-1)?.language ?? (record.language === 'hinglish' ? 'Hinglish' : 'English');
  return { summary: `Explained in ${language} using decision facts only.` };
});

const humanReview = node('human_review', async (state, { record }) => {
  addTimeline(record, {
    status: 'human_review',
    title: 'Routed to a specialist',
    detail: `Saathi could not complete the automated step: ${state.error}`,
    actor: 'saathi',
  });
  await addLocalizedMessage(record, 'I could not complete this step safely, so I routed your case to a Saathi specialist with your passport.');
  return { summary: `Failure routed to a specialist: ${state.error}` };
});

const failed = (state: State) => Boolean(state.error);

const graph = new StateGraph(AgentState)
  .addNode('classifier', classifier)
  .addNode('consent_gate', consentGate)
  .addNode('context_retriever', contextRetriever)
  .addNode('policy_rag', policyRag)
  .addNode('bill_auditor', billAuditor)
  .addNode('transaction_auditor', transactionAuditor)
  .addNode('emi_auditor', emiAuditor)
  .addNode('decision', decision)
  .addNode('explainer', explainer)
  .addNode('human_review', humanReview)
  .addConditionalEdges(START, (state) => (state.trigger === 'intake' ? 'classifier' : 'consent_gate'), ['classifier', 'consent_gate'])
  .addConditionalEdges('classifier', (state) => (failed(state) ? 'human_review' : 'consent_gate'), ['human_review', 'consent_gate'])
  .addConditionalEdges(
    'consent_gate',
    (state) => (failed(state) ? 'human_review' : state.paused ? END : 'context_retriever'),
    ['human_review', 'context_retriever', END],
  )
  .addConditionalEdges(
    'context_retriever',
    (state, config) => {
      if (failed(state)) return 'human_review';
      const { record } = contextOf(config);
      if (playbookForCase(record).auditor === 'transaction_auditor') return 'transaction_auditor';
      if (record.event_type === 'hospitalization' && state.trigger === 'documents_updated') return 'decision';
      return 'policy_rag';
    },
    ['human_review', 'transaction_auditor', 'decision', 'policy_rag'],
  )
  .addConditionalEdges(
    'policy_rag',
    (state, config) => {
      if (failed(state)) return 'human_review';
      const auditor = playbookForCase(contextOf(config).record).auditor;
      return auditor === 'bill_auditor' || auditor === 'emi_auditor' ? auditor : 'decision';
    },
    ['human_review', 'bill_auditor', 'emi_auditor', 'decision'],
  )
  .addConditionalEdges('emi_auditor', (state) => (failed(state) ? 'human_review' : 'decision'), ['human_review', 'decision'])
  .addConditionalEdges('bill_auditor', (state) => (failed(state) ? 'human_review' : 'decision'), ['human_review', 'decision'])
  .addConditionalEdges(
    'transaction_auditor',
    (state) => (failed(state) ? 'human_review' : state.paused ? END : 'decision'),
    ['human_review', 'decision', END],
  )
  .addConditionalEdges('decision', (state) => (failed(state) ? 'human_review' : 'explainer'), ['human_review', 'explainer'])
  .addEdge('explainer', END)
  .addEdge('human_review', END);

export const saathiGraph = graph.compile();

export function graphMermaid(): string {
  return saathiGraph.getGraph().drawMermaid();
}

export async function runAgent(
  record: CaseRecord,
  principal: Principal,
  trigger: AgentTrigger,
  input: { transaction_id?: string; grantConsent?: () => void } = {},
): Promise<{ visited: AgentNodeId[]; paused: string | null; error: string | null }> {
  const tracer = new RunTracer(record, trigger);
  const result = await saathiGraph.invoke(
    { trigger, grant_consent: Boolean(input.grantConsent), transaction_id: input.transaction_id ?? null, paused: null, error: null },
    {
      configurable: { saathi: { record, principal, tracer, grantConsent: input.grantConsent } satisfies RunContext },
      recursionLimit: 20,
    },
  );
  tracer.finish(result.error ? 'routed_to_specialist' : result.paused ?? record.status);
  return { visited: result.visited, paused: result.paused, error: result.error };
}
