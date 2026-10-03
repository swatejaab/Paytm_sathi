import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { addTimeline, EVENT_LABELS, hasConsent, supersedePendingActions } from '../caseStore';
import {
  calculateEmiShortfall,
  computeEmiDecision,
  computeHospitalDecision,
  computeHumanOnlyDecision,
  computeUpiDecision,
  formatInr,
  parseBillQuery,
  parseStatedAmount,
  type BillQuery,
} from '../decision';
import { sampleHospitalDocuments } from '../documents';
import { assessAffordability, parseIndianAmount, purchaseCategory } from '../afford';
import {
  fixtures,
  PARTNERS,
  type AffordabilityRules,
  type FinancialProfile,
  type LenderOffer,
  type LoanContext,
  type SampleDocuments,
} from '../fixtures';
import { GatewayError } from '../mcp/errors';
import { invokeTool } from '../mcp/gateway';
import { recordAudit } from '../db';
import type { AgentNodeId, AgentTrigger, CaseRecord, EvidencePassage, Playbook, Principal, Transaction } from '../types';
import { consentNeededMessage, detectLanguage, explainDecision, pickTransactionMessage } from './explainer';
import { sarvamAvailable } from '../config';
import { translateWithSarvam } from '../integrations';
import { runDeclarativeDecision } from '../playbooks/declarative';
import { classifyWithPlaybooks, namesSituation, playbookForCase } from '../playbooks/registry';
import type { CoverageAssessment } from '../coverage';
import { householdContext } from '../insurance';
import { addLocalizedMessage } from './localize';
import { aiAllowed, composeReply } from './compose';
import { RunTracer } from './trace';

const READ_CONSENT = 'prepare_resolution_options' as const;
const KNOWLEDGE_BUDGET_MS = 8_000;

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
  checklist?: { clause_id: string; page: number; missing: string[] };
  bill?: SampleDocuments['bill'];
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

// The bill the customer described: their stated total and room days, if they gave them.
// The bill, what the person can pay now, and the stay length, read from every message in the case so a
// follow-up such as "I can pay 25000" updates the plan. Later messages override earlier ones.
function billQuery(record: CaseRecord): BillQuery {
  const texts = [
    record.message_for_rules ?? record.customer_message,
    ...record.messages.filter((message) => message.role === 'user').slice(1).map((message) => message.content),
  ];
  const merged: BillQuery = { bill_inr: null, can_pay_inr: null, room_days: null, assumed_thousands: false, raw_bill: null };
  for (const text of texts) {
    const query = parseBillQuery(text);
    if (query.bill_inr !== null && !(query.assumed_thousands && merged.bill_inr !== null)) {
      merged.bill_inr = query.bill_inr;
      merged.assumed_thousands = query.assumed_thousands;
      merged.raw_bill = query.raw_bill;
    }
    if (query.can_pay_inr !== null) merged.can_pay_inr = query.can_pay_inr;
    if (query.room_days !== null) merged.room_days = query.room_days;
  }
  return merged;
}

function billRequest(record: CaseRecord): Record<string, number> {
  const query = billQuery(record);
  return {
    ...(query.bill_inr && query.bill_inr >= 1000 ? { stated_total_inr: query.bill_inr } : {}),
    ...(query.room_days ? { room_days: query.room_days } : {}),
  };
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
  const text = await rulesText(record);
  if (text !== record.customer_message) record.message_for_rules = text;
  const classification = classifyWithPlaybooks(text);
  record.playbook_id = classification.playbook.id;
  record.event_type = classification.event_type;
  record.urgency = classification.urgency;
  record.language = record.preferred_language ? 'en' : detectLanguage(record.customer_message);
  addTimeline(record, {
    status: 'intake',
    title: 'Case opened',
    detail: `Classified as ${EVENT_LABELS[record.event_type]} (${record.urgency} urgency).`,
    actor: 'saathi',
  });
  recordAudit({ case_id: record.case_id, actor: context.principal.sub, event: 'case_created', detail: { event_type: record.event_type } });
  return {
    summary: `${EVENT_LABELS[record.event_type]}, ${record.urgency} urgency, language ${record.language}; playbook ${classification.playbook.id} v${classification.playbook.version} (${classification.playbook.engine}).`,
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
          ? 'Hospitalization, high urgency. Loading the bill, policy, and cash context through the MCP gateway.'
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
    summary: `Cash context loaded: ${formatInr(profile.available_to_pay_inr)} available now, ${formatInr(profile.emergency_savings_inr)} savings.${aaNote}`,
  };
});

const policyRag = node('policy_rag', async (_state, context) => {
  const { record } = context;
  if (record.event_type !== 'hospitalization') {
    const playbook = await callTool<Playbook | null>(context, 'knowledge.search_playbook', { event_type: record.event_type });
    return { update: { gathered: { playbook } }, summary: playbook ? `Playbook ${playbook.playbook_id}: ${playbook.title}.` : 'No playbook found.' };
  }
  await callTool(context, 'insurer.get_policy');
  const clauses = await callTool<EvidencePassage[]>(context, 'knowledge.search_policy', {
    query: 'hospital inpatient claim room bill documents',
    top_k: 5,
  });
  const checklist = await callTool<{ clause_id: string; page: number; missing: string[] }>(context, 'insurer.get_claim_checklist');
  return {
    update: { gathered: { clauses, checklist } },
    summary: `Cited clauses ${clauses.map((clause) => clause.clause_id).join(', ')}; claim checklist clause ${checklist.clause_id}.`,
  };
});

// With no amount and no confirmed bill there is nothing real to calculate, so Saathi gives the first steps
// from the customer's own policy and balance and asks for the numbers instead of assuming a bill.
async function askForBillAmount(record: CaseRecord, profile: FinancialProfile | undefined): Promise<void> {
  const { schedule } = fixtures.documents.policy;
  const lines = [
    "I'm sorry you're going through this. Here is what to do right now:",
    `1. Ask the hospital's insurance desk for a cashless claim. Your health policy covers up to ${formatInr(schedule.sum_insured_inr)} a year, with room rent up to ${formatInr(schedule.room_rent_limit_per_day_inr)} a day and a ${formatInr(schedule.deductible_per_claim_inr)} deductible.`,
    '2. Keep the admission note, your ID and the policy card ready.',
    profile
      ? `3. You have ${formatInr(profile.account_balance_inr)} in your account and ${formatInr(profile.emergency_savings_inr)} in savings. Don't use it all yet.`
      : '3. Avoid paying the full amount from savings until you know what insurance covers.',
    'To build your exact plan, tell me the bill or estimate amount (for example "the bill is 1.2 lakh") and how much you can pay now. You can also upload a photo of the bill.',
  ];
  addTimeline(record, { title: 'Waiting for the bill amount', detail: 'No amount or bill yet, so no plan was calculated.', actor: 'saathi' });
  const question = record.messages.filter((message) => message.role === 'user').at(-1)?.content ?? record.customer_message;
  await composeReply(record, { question, draft: lines.join('\n'), withCase: false });
}

const billAuditor = node('bill_auditor', async (state, context) => {
  const { record } = context;
  if (!record.confirmed_bill && billQuery(record).bill_inr === null) {
    await askForBillAmount(record, state.gathered.profile);
    return { summary: 'No bill amount yet; asked the customer instead of assuming one.', paused: 'awaiting_bill_amount' };
  }
  const bill = await callTool<SampleDocuments['bill']>(context, 'hospital.get_bill', billRequest(record));
  const lineTotal = bill.lines.reduce((sum, line) => sum + line.amount_inr, 0);
  const coverage = await callTool<Coverage>(context, 'insurer.check_coverage', { bill_total_inr: bill.total_inr, lines: billLines(bill.lines) });
  const missing = state.gathered.checklist?.missing ?? [];
  const findings = [
    lineTotal === bill.total_inr ? `Lines reconcile to ${formatInr(bill.total_inr)}` : `Lines total ${formatInr(lineTotal)}, not ${formatInr(bill.total_inr)}`,
  ];
  const stated = parseStatedAmount(record.message_for_rules ?? record.customer_message);
  if (stated && stated !== bill.total_inr) findings.push(`customer stated ${formatInr(stated)}`);
  if (missing.length) findings.push(`missing: ${missing.join(', ')}`);

  record.evidence = {
    demo_only: true,
    fixture_id: fixtures.documents.fixture_id,
    documents: sampleHospitalDocuments(),
    retrieved_evidence: state.gathered.clauses ?? [],
    missing_documents: missing,
    notice: 'Estimate from your records; the insurer makes the final coverage decision.',
  };
  addTimeline(record, {
    status: 'evidence_ready',
    title: 'Evidence gathered',
    detail: `Bill lines ${bill.lines.map((line) => line.line).join(', ')}, policy clauses ${(state.gathered.clauses ?? []).map((clause) => clause.clause_id).join(', ')}; missing: ${missing.join(', ') || 'none'}.`,
    actor: 'saathi',
  });
  return { update: { gathered: { bill, coverage } }, summary: `${findings.join('; ')}. Coverage estimate ${formatInr(coverage.estimated_coverage_inr)} (confidence ${coverage.confidence}).` };
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
    const stated = picker.match_stated_amount ? parseStatedAmount(record.message_for_rules ?? record.customer_message) : null;
    let candidates = await callTool<Transaction[]>(context, 'payments.list_transactions', {
      ...picker.filter,
      limit: 5,
      ...(stated ? { amount_inr: stated } : {}),
    });
    if (!candidates.length && stated) {
      candidates = await callTool<Transaction[]>(context, 'payments.list_transactions', { ...picker.filter, limit: 5 });
    }
    record.pending_question = { type: 'confirm_transaction', prompt: picker.prompt, candidates, mode: picker.mode };
    addTimeline(record, { title: 'Waiting for you to pick the transaction', detail: `${candidates.length} candidate debit(s).`, actor: 'saathi' });
    await addLocalizedMessage(
      record,
      picker.mode === 'select'
        ? candidates.length
          ? `I found ${candidates.length} failed payment(s) on your account. Pick the one that is missing its refund and I will check the deadline and compensation.`
          : 'I could not find a failed payment on your account. A specialist can trace it for you.'
        : pickTransactionMessage(record.language, candidates.length, stated, Boolean(stated && candidates.some((candidate) => candidate.amount_inr === stated))),
    );
    return { summary: `${candidates.length} candidate debit(s); waiting for the customer to pick one.`, paused: 'awaiting_transaction' };
  }

  const transaction = await callTool<Transaction>(context, 'payments.get_transaction', { transaction_id: state.transaction_id });
  const playbook = await callTool<Playbook | null>(context, 'knowledge.search_playbook', { event_type: record.event_type });
  record.evidence = {
    demo_only: true,
    documents: [],
    retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
    missing_documents: [],
    transaction,
    playbook,
    notice: 'Dispute outcomes come from the bank; Saathi prepares and tracks the request.',
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
    demo_only: true,
    documents: [],
    retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
    missing_documents: [],
    playbook,
    notice: 'The lender makes the final decision; Saathi prepares and tracks the request.',
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
  const { loans: _loans, ...loanContext } = loans;
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
  const confirmed = record.confirmed_bill;
  // A bill the customer uploaded and confirmed replaces the hospital record; coverage is re-checked against its total.
  const bill: SampleDocuments['bill'] = confirmed
    ? {
        document_id: confirmed.document_id,
        document_type: 'bill',
        file_name: confirmed.document_name,
        page: 1,
        currency: 'INR',
        total_inr: confirmed.total_inr,
        lines: confirmed.lines,
      }
    : (state.gathered.bill ?? await callTool<SampleDocuments['bill']>(context, 'hospital.get_bill', billRequest(record)));
  const coverage =
    (confirmed ? undefined : state.gathered.coverage) ??
    await callTool<Coverage>(context, 'insurer.check_coverage', { bill_total_inr: bill.total_inr, lines: billLines(bill.lines) });
  const checklist = state.gathered.checklist ?? await callTool<{ clause_id: string; page: number; missing: string[] }>(context, 'insurer.get_claim_checklist');
  const query = billQuery(record);
  const recorded = state.gathered.profile ?? await callTool<FinancialProfile>(context, 'payments.get_balance');
  // What the person says they can pay now replaces the amount on record; everything else stays from their accounts.
  const profile: FinancialProfile = query.can_pay_inr !== null ? { ...recorded, available_to_pay_inr: query.can_pay_inr } : recorded;
  const roughGap = Math.max(bill.total_inr - coverage.estimated_coverage_inr - profile.available_to_pay_inr, 0);
  const offerSets: { offers: LenderOffer[]; rules: AffordabilityRules }[] = [];
  for (const amount of [roughGap, bill.total_inr].filter((value) => value > 0)) {
    offerSets.push(await callTool<{ offers: LenderOffer[]; rules: AffordabilityRules }>(context, 'lending.get_offers', { amount_inr: amount }));
  }
  const offers = [...new Map(offerSets.flatMap((set) => set.offers).map((offer) => [offer.offer_id, offer])).values()];

  record.decision = computeHospitalDecision({
    caseId: record.case_id,
    urgency: record.urgency,
    bill,
    coverage,
    assumptions: coverage.assumptions,
    claimChecklist: checklist,
    profile,
    offers,
    rules: offerSets[0]?.rules ?? fixtures.lending.affordability_rules,
    partners: { insurer: PARTNERS.insurer, lender: PARTNERS.lender, hospital: PARTNERS.hospital },
    statedAmountInr: query.bill_inr,
    verification: verificationNeeded(record),
  });
  record.decision.coverage_breakdown = coverage.assessment;
  const notes: string[] = [];
  const said = [record.message_for_rules ?? record.customer_message, ...record.messages.filter((m) => m.role === 'user').map((m) => m.content)].join(' ');
  if (!namesSituation(playbookForCase(record), said)) {
    notes.push('I treated this as a medical emergency. If it is something else, such as an EMI or a payment problem, tell me and I will change the plan.');
  }
  if (!confirmed && query.assumed_thousands) notes.push(`I read "${query.raw_bill}" as ${formatInr(bill.total_inr)}. Tell me the exact amount if that is wrong.`);
  if (!confirmed && query.bill_inr === null) notes.push(`You did not mention an amount, so this uses the hospital's current bill of ${formatInr(bill.total_inr)}.`);
  if (query.can_pay_inr !== null) {
    notes.push(`Using the ${formatInr(query.can_pay_inr)} you said you can pay now.`);
    const liquid = recorded.account_balance_inr + recorded.emergency_savings_inr;
    if (query.can_pay_inr > liquid) notes.push(`That is more than your balance and savings together (${formatInr(liquid)}); check the money is available before you pay.`);
  } else {
    notes.push(`Using ${formatInr(recorded.available_to_pay_inr)} from your balance as what you can pay now. Tell me if you can pay more or less.`);
  }
  if ((bill as { estimated?: boolean }).estimated) notes.push('Line items are estimated from the amount you gave. Upload the itemised bill for exact cover.');
  record.decision.warnings = [...record.decision.warnings, ...notes];
  return `Formula ${record.decision.formula_version}; cover ${formatInr(coverage.estimated_coverage_inr)} (${coverage.assessment.rules_version}); gap ${formatInr(record.decision.calculation?.exact_gap_inr ?? 0)}`;
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
      demo_only: true,
      documents: [],
      retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
      missing_documents: [],
      playbook,
      notice: 'This journey has no automated playbook in the demo.',
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

// The assumptions behind a plan (what was read from the message, what was taken from the accounts) belong in
// the reply itself, not only in the plan tab, so the customer can correct them.
export function assumptionNotes(record: CaseRecord): string[] {
  return (record.decision?.warnings ?? []).filter((warning) => /^(I treated|I read|Using|That is more|You did not)/.test(warning));
}

const explainer = node('explainer', async (_state, context) => {
  const { record } = context;
  const question = record.messages.filter((message) => message.role === 'user').at(-1)?.content ?? record.customer_message;
  if (record.event_type === 'general_financial_support') {
    // "Can I afford / buy ..." is answered by the affordability engine, not general guidance.
    const affordText = record.message_for_rules ?? record.customer_message;
    const price = /\b(afford|buy|purchase|kharid|lena|lun|loon)\b|खरीद/i.test(affordText) ? parseIndianAmount(affordText) : null;
    if (price) {
      const item = affordText.replace(/^(can|could|should)\s+i\s+(afford|buy)\s+(an?\s+)?/i, '').replace(/\?+$/, '').slice(0, 80);
      const assessment = assessAffordability(record.customer_id, { amount_inr: price, item, category: purchaseCategory(affordText) });
      if (assessment) {
        const recommended = assessment.scenarios.find((scenario) => scenario.id === assessment.recommended_id);
        const draft = [assessment.headline, recommended && recommended.title !== assessment.headline ? `Best option: ${recommended.title}. ${recommended.effect}` : '', assessment.warning ?? '']
          .filter(Boolean)
          .join(' ');
        const source = await composeReply(record, { question, draft, facts: { affordability: assessment } });
        return { summary: `Affordability engine: ${assessment.verdict} for ${formatInr(price)}; ${source === 'openai' ? 'explained by OpenAI from account facts' : 'calculated text'}.` };
      }
    }
    type Knowledge = { answer: string | null; sources: { title: string | null; clause_id: string | null; page: number | null }[]; backend: string };
    // The knowledge graph gets a time budget; past it, Saathi answers from the account facts alone.
    const knowledge = await Promise.race([
      callTool<Knowledge>(context, 'knowledge.ask', { question: record.message_for_rules ?? record.customer_message }),
      new Promise<Knowledge>((resolve) => setTimeout(() => resolve({ answer: null, sources: [], backend: 'timed_out' }), KNOWLEDGE_BUDGET_MS)),
    ]);
    const sources = [...new Set(knowledge.sources.map((source) => source.title).filter(Boolean))];
    if (knowledge.answer && record.evidence) {
      record.evidence.retrieved_evidence = knowledge.sources.map((source, index) => ({
        document_id: `KB-${index + 1}`,
        document_name: 'Saathi knowledge graph (Cognee)',
        document_type: 'knowledge',
        page: source.page ?? 1,
        title: source.title ?? 'Knowledge',
        text: source.title ?? '',
        score: knowledge.sources.length - index,
        retrieval: 'cognee',
      }));
      record.evidence.notice = 'General guidance from the Saathi knowledge graph (Cognee), applied to your own account figures.';
    }
    if (knowledge.answer || aiAllowed(record)) {
      // General questions are answered from the knowledge graph plus the customer's own account figures.
      const draft = knowledge.answer
        ? `${knowledge.answer}${sources.length ? ` (Sources: ${sources.join('; ')}.)` : ''} This is general guidance. A Saathi specialist can look at your situation if you want.`
        : undefined;
      const before = record.messages.length;
      const source = await composeReply(record, { question, draft, knowledge: knowledge.answer, withCase: false });
      if (record.messages.length > before) {
        return { summary: `Answered ${source === 'openai' ? 'by OpenAI from account facts and ' : 'from '}the knowledge graph (${knowledge.backend}), ${knowledge.sources.length} source(s).` };
      }
    }
  }
  const source = await composeReply(record, { question, draft: [explainDecision(record), ...assumptionNotes(record)].join(' ') });
  return { summary: source === 'openai' ? 'OpenAI explained the calculated plan using the account facts; numbers checked.' : 'Explained using decision facts only.' };
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
  .addConditionalEdges('bill_auditor', (state) => (failed(state) ? 'human_review' : state.paused ? END : 'decision'), ['human_review', 'decision', END])
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
