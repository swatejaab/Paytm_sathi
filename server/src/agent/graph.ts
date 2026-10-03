import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from '@langchain/langgraph';
import { addTimeline, EVENT_LABELS, hasConsent, supersedePendingActions } from '../caseStore';
import {
  calculateEmiShortfall,
  classifyEvent,
  computeEmiDecision,
  computeHospitalDecision,
  computeHumanOnlyDecision,
  computeUpiDecision,
  formatInr,
  parseStatedAmount,
} from '../decision';
import { sampleHospitalDocuments } from '../documents';
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
import { addLocalizedMessage } from './localize';
import { RunTracer } from './trace';

const READ_CONSENT = 'prepare_resolution_options' as const;

interface Coverage {
  estimated_coverage_inr: number;
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

function callTool<T>(context: RunContext, tool: string, input: Record<string, unknown> = {}): T {
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

const classifier = node('classifier', (_state, context) => {
  const { record } = context;
  const classification = classifyEvent(record.customer_message);
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
  return { summary: `${EVENT_LABELS[record.event_type]}, ${record.urgency} urgency, language ${record.language}.` };
});

const consentGate = node('consent_gate', async (state, { record, grantConsent }) => {
  if (state.grant_consent && !hasConsent(record, READ_CONSENT)) grantConsent?.();
  if (hasConsent(record, READ_CONSENT)) return { summary: 'Consent "prepare resolution options" is active.' };
  if (state.trigger === 'intake') await addLocalizedMessage(record, consentNeededMessage(record.language));
  return { summary: 'No consent yet; nothing was read.', paused: 'awaiting_consent' };
});

const contextRetriever = node('context_retriever', (state, context) => {
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
  const profile = callTool<FinancialProfile>(context, 'payments.get_balance');
  return {
    update: { gathered: { profile } },
    summary: `Cash context loaded: ${formatInr(profile.available_to_pay_inr)} available now, ${formatInr(profile.emergency_savings_inr)} savings.`,
  };
});

const policyRag = node('policy_rag', (_state, context) => {
  const { record } = context;
  if (record.event_type !== 'hospitalization') {
    const playbook = callTool<Playbook | null>(context, 'knowledge.search_playbook', { event_type: record.event_type });
    return { update: { gathered: { playbook } }, summary: playbook ? `Playbook ${playbook.playbook_id}: ${playbook.title}.` : 'No playbook found.' };
  }
  callTool(context, 'insurer.get_policy');
  const clauses = callTool<EvidencePassage[]>(context, 'knowledge.search_policy', {
    query: 'hospital inpatient claim room bill documents',
    top_k: 3,
  });
  const checklist = callTool<{ clause_id: string; page: number; missing: string[] }>(context, 'insurer.get_claim_checklist');
  return {
    update: { gathered: { clauses, checklist } },
    summary: `Cited clauses ${clauses.map((clause) => clause.clause_id).join(', ')}; claim checklist clause ${checklist.clause_id}.`,
  };
});

const billAuditor = node('bill_auditor', (state, context) => {
  const { record } = context;
  const bill = callTool<SampleDocuments['bill']>(context, 'hospital.get_bill');
  const lineTotal = bill.lines.reduce((sum, line) => sum + line.amount_inr, 0);
  const coverage = callTool<Coverage>(context, 'insurer.check_coverage', { bill_total_inr: bill.total_inr });
  const missing = state.gathered.checklist?.missing ?? [];
  const findings = [
    lineTotal === bill.total_inr ? `Lines reconcile to ${formatInr(bill.total_inr)}` : `Lines total ${formatInr(lineTotal)}, not ${formatInr(bill.total_inr)}`,
  ];
  const stated = parseStatedAmount(record.customer_message);
  if (stated && stated !== bill.total_inr) findings.push(`customer stated ${formatInr(stated)}`);
  if (missing.length) findings.push(`missing: ${missing.join(', ')}`);

  record.evidence = {
    demo_only: true,
    fixture_id: fixtures.documents.fixture_id,
    documents: sampleHospitalDocuments(),
    retrieved_evidence: state.gathered.clauses ?? [],
    missing_documents: missing,
    notice: 'Synthetic sample evidence; not a real coverage decision.',
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
  if (!state.transaction_id) {
    const stated = parseStatedAmount(record.customer_message);
    let candidates = callTool<Transaction[]>(context, 'payments.list_transactions', {
      direction: 'debit',
      limit: 5,
      ...(stated ? { amount_inr: stated } : {}),
    });
    if (!candidates.length && stated) {
      candidates = callTool<Transaction[]>(context, 'payments.list_transactions', { direction: 'debit', limit: 5 });
    }
    record.pending_question = { type: 'confirm_transaction', prompt: 'Which payment do you not recognize?', candidates };
    addTimeline(record, { title: 'Waiting for you to pick the transaction', detail: `${candidates.length} candidate debit(s).`, actor: 'saathi' });
    await addLocalizedMessage(
      record,
      pickTransactionMessage(record.language, candidates.length, stated, Boolean(stated && candidates.some((candidate) => candidate.amount_inr === stated))),
    );
    return { summary: `${candidates.length} candidate debit(s); waiting for the customer to pick one.`, paused: 'awaiting_transaction' };
  }

  const transaction = callTool<Transaction>(context, 'payments.get_transaction', { transaction_id: state.transaction_id });
  const playbook = callTool<Playbook | null>(context, 'knowledge.search_playbook', { event_type: 'upi_dispute' });
  record.evidence = {
    demo_only: true,
    documents: [],
    retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
    missing_documents: [],
    transaction,
    playbook,
    notice: 'Synthetic transaction and playbook; dispute outcomes are simulated.',
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

const emiAuditor = node('emi_auditor', (state, context) => {
  const { record } = context;
  const loans = callTool<LoanContext>(context, 'lending.get_loans');
  const loan = loans.loans[0];
  const playbook = state.gathered.playbook ?? null;
  record.evidence = {
    demo_only: true,
    documents: [],
    retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
    missing_documents: [],
    playbook,
    notice: 'Synthetic loan account, salary schedule, and playbook; lender outcomes are simulated.',
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

function emiDecision(state: State, context: RunContext): string {
  const { record } = context;
  const loans = state.gathered.loans ?? callTool<LoanContext>(context, 'lending.get_loans');
  const loan = loans.loans[0];
  const playbook = state.gathered.playbook ?? null;
  if (!loan) {
    record.decision = computeHumanOnlyDecision({ eventType: record.event_type, urgency: record.urgency, playbook });
    record.decision.explanation = 'I could not find an active loan or EMI on your account, so a specialist will continue from your passport.';
    return 'No active EMI; specialist route';
  }
  const profile = state.gathered.profile ?? callTool<FinancialProfile>(context, 'payments.get_balance');
  const { shortfall_inr: shortfall } = calculateEmiShortfall({
    emi_inr: loan.emi_inr,
    account_balance_inr: profile.account_balance_inr,
    committed_before_due_inr: loans.committed_before_due_inr,
  });
  const offerSet = shortfall > 0
    ? callTool<{ offers: LenderOffer[]; rules: AffordabilityRules }>(context, 'lending.get_offers', { amount_inr: shortfall })
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

function hospitalDecision(state: State, context: RunContext): string {
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
    : (state.gathered.bill ?? callTool<SampleDocuments['bill']>(context, 'hospital.get_bill'));
  const coverage =
    (confirmed ? undefined : state.gathered.coverage) ??
    callTool<Coverage>(context, 'insurer.check_coverage', { bill_total_inr: bill.total_inr });
  const checklist = state.gathered.checklist ?? callTool<{ clause_id: string; page: number; missing: string[] }>(context, 'insurer.get_claim_checklist');
  const profile = state.gathered.profile ?? callTool<FinancialProfile>(context, 'payments.get_balance');
  const roughGap = Math.max(bill.total_inr - coverage.estimated_coverage_inr - profile.available_to_pay_inr, 0);
  const offerSets = [roughGap, bill.total_inr]
    .filter((amount) => amount > 0)
    .map((amount) => callTool<{ offers: LenderOffer[]; rules: AffordabilityRules }>(context, 'lending.get_offers', { amount_inr: amount }));
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
    statedAmountInr: parseStatedAmount(record.customer_message),
    verification: verificationNeeded(record),
  });
  return `Formula ${record.decision.formula_version}; gap ${formatInr(record.decision.calculation?.exact_gap_inr ?? 0)}`;
}

const decision = node('decision', (state, context) => {
  const { record } = context;
  supersedePendingActions(record, 'The options were recalculated, so any earlier approval request no longer applies.');
  let detail: string;
  if (record.event_type === 'hospitalization') {
    detail = hospitalDecision(state, context);
  } else if (record.event_type === 'upi_dispute') {
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
  } else if (record.event_type === 'emi_shortfall') {
    detail = emiDecision(state, context);
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
      if (record.event_type === 'upi_dispute') return 'transaction_auditor';
      if (record.event_type === 'hospitalization' && state.trigger === 'documents_updated') return 'decision';
      return 'policy_rag';
    },
    ['human_review', 'transaction_auditor', 'decision', 'policy_rag'],
  )
  .addConditionalEdges(
    'policy_rag',
    (state, config) => {
      if (failed(state)) return 'human_review';
      const eventType = contextOf(config).record.event_type;
      return eventType === 'hospitalization' ? 'bill_auditor' : eventType === 'emi_shortfall' ? 'emi_auditor' : 'decision';
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
