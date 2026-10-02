import {
  addMessage,
  addTimeline,
  EVENT_LABELS,
  hasConsent,
  loadCaseForOwner,
  newId,
  supersedePendingActions,
} from './caseStore';
import { insertCase, nowIso, recordAudit, updateCase } from './db';
import {
  classifyEvent,
  computeHospitalDecision,
  computeHumanOnlyDecision,
  computeUpiDecision,
  formatInr,
  parseStatedAmount,
} from './decision';
import { sampleHospitalDocuments } from './documents';
import { HttpError } from './errors';
import { fixtures, PARTNERS, type AffordabilityRules, type FinancialProfile, type LenderOffer, type SampleDocuments } from './fixtures';
import { GatewayError } from './mcp/errors';
import { invokeTool } from './mcp/gateway';
import type { CaseRecord, ConsentPurpose, EvidencePassage, Playbook, Principal, Transaction } from './types';

const READ_CONSENT: ConsentPurpose = 'prepare_resolution_options';

type ToolCaller = <T>(tool: string, input?: Record<string, unknown>) => T;

function toolCaller(record: CaseRecord, principal: Principal): ToolCaller {
  return <T>(tool: string, input: Record<string, unknown> = {}) =>
    invokeTool<T>(tool, { case_id: record.case_id, ...input }, { principal, caseRecord: record });
}

function routeFailureToHuman(record: CaseRecord, error: unknown): void {
  const reason = error instanceof GatewayError || error instanceof Error ? error.message : 'Unknown error';
  addTimeline(record, {
    status: 'human_review',
    title: 'Routed to a specialist',
    detail: `Saathi could not complete the automated step: ${reason}`,
    actor: 'saathi',
  });
  addMessage(record, 'assistant', 'I could not complete this step safely, so I routed your case to a Saathi specialist with your passport.');
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

export function decideHospital(record: CaseRecord, principal: Principal): void {
  const call = toolCaller(record, principal);
  const bill = call<SampleDocuments['bill']>('hospital.get_bill');
  const coverage = call<{
    estimated_coverage_inr: number;
    clause_id: string;
    page: number;
    confidence: number;
    policy_document_id: string;
    policy_file_name: string;
    assumptions: { clause_id: string; page: number; title: string }[];
  }>('insurer.check_coverage', { bill_total_inr: bill.total_inr });
  const checklist = call<{ clause_id: string; page: number; missing: string[] }>('insurer.get_claim_checklist');
  const profile = call<FinancialProfile>('payments.get_balance');
  const roughGap = Math.max(bill.total_inr - coverage.estimated_coverage_inr - profile.available_to_pay_inr, 0);
  const offerSets = [roughGap, bill.total_inr]
    .filter((amount) => amount > 0)
    .map((amount) => call<{ offers: LenderOffer[]; rules: AffordabilityRules }>('lending.get_offers', { amount_inr: amount }));
  const offers = [...new Map(offerSets.flatMap((set) => set.offers).map((offer) => [offer.offer_id, offer])).values()];

  const hasUploads = record.uploaded_documents.length > 0;
  const decision = computeHospitalDecision({
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
    verification: hasUploads
      ? {
          required: true,
          reason:
            'You added your own policy or bill. Saathi has not verified coverage from those files, so claim and credit steps wait for a specialist.',
        }
      : { required: false },
  });

  supersedePendingActions(record, 'The options were recalculated, so any earlier approval request no longer applies.');
  record.decision = decision;
  const best = decision.options.find((option) => option.recommended);
  addTimeline(record, {
    status: 'options_ready',
    title: 'Options compared',
    detail: best ? `Recommended: ${best.title} (${best.scores.total}/100). Formula ${decision.formula_version}.` : 'No safe automated option.',
    actor: 'saathi',
  });
  const gapLine = decision.calculation
    ? `Exact gap: ${formatInr(decision.calculation.bill_total_inr)} bill - ${formatInr(decision.calculation.coverage_estimate_inr)} estimated cover - ${formatInr(decision.calculation.customer_contribution_inr)} you can pay = ${formatInr(decision.calculation.exact_gap_inr)}. `
    : '';
  addMessage(record, 'assistant', `${gapLine}${decision.explanation} Nothing is submitted until you approve a specific plan.`);
}

function runHospital(record: CaseRecord, principal: Principal): void {
  const call = toolCaller(record, principal);
  addTimeline(record, {
    status: 'understand',
    title: 'Understanding the event',
    detail: 'Hospitalization, high urgency. Loading the bill, policy, and cash context through the MCP gateway.',
    actor: 'saathi',
  });
  call('hospital.get_bill');
  call('insurer.get_policy');
  const checklist = call<{ missing: string[] }>('insurer.get_claim_checklist');
  const clauses = call<EvidencePassage[]>('knowledge.search_policy', {
    query: 'hospital inpatient claim room bill documents',
    top_k: 3,
  });
  record.evidence = {
    demo_only: true,
    fixture_id: fixtures.documents.fixture_id,
    documents: sampleHospitalDocuments(),
    retrieved_evidence: clauses,
    missing_documents: checklist.missing,
    notice: 'Synthetic sample evidence; not a real coverage decision.',
  };
  addTimeline(record, {
    status: 'evidence_ready',
    title: 'Evidence gathered',
    detail: `Bill lines 4-7, policy clauses ${clauses.map((clause) => clause.clause_id).join(', ')}; missing: ${checklist.missing.join(', ') || 'none'}.`,
    actor: 'saathi',
  });
  decideHospital(record, principal);
}

function startUpi(record: CaseRecord, principal: Principal): void {
  const call = toolCaller(record, principal);
  addTimeline(record, {
    status: 'understand',
    title: 'Understanding the event',
    detail: 'Possible unrecognized UPI debit. Loading recent debits through the payments MCP.',
    actor: 'saathi',
  });
  const stated = parseStatedAmount(record.customer_message);
  let candidates = call<Transaction[]>('payments.list_transactions', {
    direction: 'debit',
    limit: 5,
    ...(stated ? { amount_inr: stated } : {}),
  });
  if (!candidates.length && stated) {
    candidates = call<Transaction[]>('payments.list_transactions', { direction: 'debit', limit: 5 });
  }
  record.pending_question = {
    type: 'confirm_transaction',
    prompt: 'Which payment do you not recognize?',
    candidates,
  };
  addTimeline(record, { title: 'Waiting for you to pick the transaction', detail: `${candidates.length} candidate debit(s).`, actor: 'saathi' });
  addMessage(
    record,
    'assistant',
    stated && candidates.some((candidate) => candidate.amount_inr === stated)
      ? `I found ${candidates.length} debit(s) of ${formatInr(stated)}. Pick the one you don't recognize. I will show the evidence before anything is filed.`
      : 'Here are your recent debits. Pick the one you do not recognize. I will show the evidence before anything is filed.',
  );
}

function runHumanOnly(record: CaseRecord, principal: Principal): void {
  const call = toolCaller(record, principal);
  addTimeline(record, {
    status: 'understand',
    title: 'Understanding the event',
    detail: `${EVENT_LABELS[record.event_type]}, ${record.urgency} urgency.`,
    actor: 'saathi',
  });
  const playbook = call<Playbook | null>('knowledge.search_playbook', { event_type: record.event_type });
  record.evidence = {
    demo_only: true,
    documents: [],
    retrieved_evidence: playbook ? [playbookPassage(playbook)] : [],
    missing_documents: [],
    playbook,
    notice: 'This journey has no automated playbook in the demo.',
  };
  record.decision = computeHumanOnlyDecision({ eventType: record.event_type, urgency: record.urgency, playbook });
  addTimeline(record, { status: 'options_ready', title: 'Options compared', detail: 'Specialist support recommended.', actor: 'saathi' });
  addMessage(record, 'assistant', `${record.decision.explanation} You can share your Resolution Passport so you don't have to repeat your story.`);
}

export function runWorkflow(record: CaseRecord, principal: Principal): void {
  try {
    if (record.event_type === 'hospitalization') runHospital(record, principal);
    else if (record.event_type === 'upi_dispute') startUpi(record, principal);
    else runHumanOnly(record, principal);
  } catch (error) {
    routeFailureToHuman(record, error);
  }
}

export function createCase(principal: Principal, message: string, consentGranted: boolean): CaseRecord {
  const classification = classifyEvent(message);
  const now = nowIso();
  const record: CaseRecord = {
    case_id: newId('SA'),
    customer_id: principal.sub,
    event_type: classification.event_type,
    urgency: classification.urgency,
    status: 'intake',
    customer_message: message.trim(),
    assistant_message: '',
    created_at: now,
    updated_at: now,
    messages: [],
    consents: [],
    evidence: null,
    uploaded_documents: [],
    pending_question: null,
    decision: null,
    actions: [],
    timeline: [],
    ai_analysis: null,
  };
  addMessage(record, 'user', record.customer_message);
  addTimeline(record, {
    status: 'intake',
    title: 'Case opened',
    detail: `Classified as ${EVENT_LABELS[record.event_type]} (${record.urgency} urgency).`,
    actor: 'saathi',
  });
  insertCase(record);
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'case_created', detail: { event_type: record.event_type } });

  if (consentGranted) {
    grantConsentRecord(record, principal);
    runWorkflow(record, principal);
  } else {
    addMessage(
      record,
      'assistant',
      'I saved your case. Before I read your synthetic policy, bill, or account records, please grant consent for this case.',
    );
  }
  updateCase(record);
  return record;
}

function grantConsentRecord(record: CaseRecord, principal: Principal): void {
  record.consents.push({ purpose: READ_CONSENT, status: 'granted', granted_at: nowIso(), revoked_at: null, actor: principal.sub });
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'consent_granted', detail: { purpose: READ_CONSENT } });
  addTimeline(record, {
    title: 'Consent granted',
    detail: 'Purpose: prepare resolution options. Saathi may read case-relevant synthetic records only.',
    actor: 'customer',
  });
}

export function setConsent(principal: Principal, caseId: string, granted: boolean): CaseRecord {
  const record = loadCaseForOwner(principal, caseId, 'consent:manage');
  const current = hasConsent(record, READ_CONSENT);
  if (granted && !current) {
    grantConsentRecord(record, principal);
    if (record.status === 'intake') runWorkflow(record, principal);
  } else if (!granted && current) {
    const latest = record.consents.filter((consent) => consent.purpose === READ_CONSENT).at(-1)!;
    latest.status = 'revoked';
    latest.revoked_at = nowIso();
    recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'consent_revoked', detail: { purpose: READ_CONSENT } });
    supersedePendingActions(record, 'Consent was revoked.');
    const midFlight = ['in_progress', 'resolved', 'human_review'].includes(record.status);
    addTimeline(record, {
      status: midFlight ? record.status : 'intake',
      title: 'Consent revoked',
      detail: midFlight
        ? 'Saathi stopped reading your records. Steps already submitted to partners continue with them.'
        : 'Saathi stopped reading your records. Grant consent again to continue.',
      actor: 'customer',
    });
  }
  updateCase(record);
  return record;
}

export function confirmTransaction(principal: Principal, caseId: string, transactionId: string, recognized: boolean): CaseRecord {
  const record = loadCaseForOwner(principal, caseId, 'case:read');
  const question = record.pending_question;
  if (!question || question.type !== 'confirm_transaction') {
    throw new HttpError(409, 'This case is not waiting for a transaction confirmation.');
  }
  if (!question.candidates.some((candidate) => candidate.transaction_id === transactionId)) {
    throw new HttpError(422, 'Pick one of the listed transactions.');
  }
  if (!hasConsent(record, READ_CONSENT)) throw new HttpError(403, 'Grant consent before Saathi reads transaction details.');

  addMessage(record, 'user', `${transactionId}: ${recognized ? 'I recognize this payment.' : 'I do not recognize this payment.'}`);
  record.pending_question = null;

  if (recognized) {
    addTimeline(record, { status: 'resolved', title: 'No dispute needed', detail: 'You recognized the payment.', actor: 'customer' });
    addMessage(record, 'assistant', 'Thanks for confirming. No dispute is needed, and nothing was filed.');
    updateCase(record);
    return record;
  }

  try {
    const call = toolCaller(record, principal);
    const transaction = call<Transaction>('payments.get_transaction', { transaction_id: transactionId });
    const playbook = call<Playbook | null>('knowledge.search_playbook', { event_type: 'upi_dispute' });
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
    record.decision = computeUpiDecision({
      caseId: record.case_id,
      urgency: record.urgency,
      transaction,
      playbook,
      paymentsPartner: PARTNERS.payments,
    });
    const best = record.decision.options.find((option) => option.recommended);
    addTimeline(record, {
      status: 'options_ready',
      title: 'Options compared',
      detail: best ? `Recommended: ${best.title} (${best.scores.total}/100).` : 'No safe automated option.',
      actor: 'saathi',
    });
    addMessage(record, 'assistant', `${record.decision.explanation} Nothing is filed until you approve.`);
  } catch (error) {
    routeFailureToHuman(record, error);
  }
  updateCase(record);
  return record;
}

export function requestHandoff(principal: Principal, caseId: string, reason?: string): CaseRecord {
  const record = loadCaseForOwner(principal, caseId, 'case:read');
  if (record.status === 'resolved') throw new HttpError(409, 'This case is already resolved.');
  supersedePendingActions(record, 'You asked for a specialist.');
  addTimeline(record, {
    status: 'human_review',
    title: 'Specialist requested',
    detail: reason?.trim() || 'A specialist will continue from your Resolution Passport.',
    actor: 'customer',
  });
  addMessage(record, 'assistant', 'A Saathi specialist will pick this up with your Resolution Passport, so you will not need to repeat your story.');
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'human_handoff', detail: { reason: reason ?? null } });
  updateCase(record);
  return record;
}
