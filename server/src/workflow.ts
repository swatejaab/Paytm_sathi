import { runAgent } from './agent/graph';
import { continueAfterBillConfirmed, createConversation, decorateAfterRun, handleTurn, resumeAfterConsent } from './assistant/turn';
import { addMessage, addTimeline, grantRecordsConsent, hasConsent, loadCaseForOwner, supersedePendingActions } from './caseStore';
import { nowIso, recordAudit, updateCase } from './db';
import { formatInr } from './decision';
import { HttpError } from './errors';
import type { CaseRecord, ParsedBillLine, Principal } from './types';

const READ_CONSENT = 'prepare_resolution_options' as const;

// Case workflow entry points. Conversations run through the assistant pipeline (assistant/turn.ts), which calls the
// bounded agent graph (agent/graph.ts) once it has the facts it needs. The persisted case record is the checkpoint.

// Starts a conversation from a single message, optionally with consent given up front.
export async function createCase(
  principal: Principal,
  message: string,
  consentGranted: boolean,
  preferredLanguage?: string,
): Promise<CaseRecord> {
  const record = createConversation(principal, preferredLanguage);
  if (consentGranted) grantRecordsConsent(record, principal);
  updateCase(record);
  return handleTurn(principal, { conversation_id: record.case_id, message, language: preferredLanguage });
}

export async function setConsent(principal: Principal, caseId: string, granted: boolean): Promise<CaseRecord> {
  const record = loadCaseForOwner(principal, caseId, 'consent:manage');
  const current = hasConsent(record, READ_CONSENT);
  if (granted && !current) {
    grantRecordsConsent(record, principal);
    if (record.context?.awaiting === 'records_consent') await resumeAfterConsent(principal, record);
  } else if (!granted && current) {
    const latest = record.consents.filter((consent) => consent.purpose === READ_CONSENT).at(-1)!;
    latest.status = 'revoked';
    latest.revoked_at = nowIso();
    recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'consent_revoked', detail: { purpose: READ_CONSENT } });
    supersedePendingActions(record, 'Consent was revoked.');
    const midFlight = ['in_progress', 'resolved', 'human_review'].includes(record.status);
    addTimeline(record, {
      status: midFlight ? record.status : 'intake',
      title: 'Access revoked',
      detail: midFlight
        ? 'Saathi stopped reading your records. Steps already submitted to partners continue with them.'
        : 'Saathi stopped reading your records. Allow access again to continue.',
      actor: 'customer',
    });
  }
  updateCase(record);
  return record;
}

export async function confirmTransaction(
  principal: Principal,
  caseId: string,
  transactionId: string,
  recognized: boolean,
): Promise<CaseRecord> {
  const record = loadCaseForOwner(principal, caseId, 'case:read');
  const question = record.pending_question;
  if (!question || question.type !== 'confirm_transaction') {
    throw new HttpError(409, 'This conversation is not waiting for a transaction confirmation.');
  }
  if (!question.candidates.some((candidate) => candidate.transaction_id === transactionId)) {
    throw new HttpError(422, 'Pick one of the listed transactions.');
  }
  if (!hasConsent(record, READ_CONSENT)) throw new HttpError(403, 'Allow access before Saathi reads transaction details.');

  const picked = question.candidates.find((candidate) => candidate.transaction_id === transactionId)!;
  addMessage(record, 'user', `${recognized ? 'I recognize' : "I don't recognize"} the ${formatInr(picked.amount_inr)} payment to ${picked.counterparty}.`);
  record.pending_question = null;

  if (recognized && question.mode !== 'select') {
    addTimeline(record, { status: 'resolved', title: 'No dispute needed', detail: 'You recognized the payment.', actor: 'customer' });
    addMessage(record, 'assistant', 'Thanks for confirming. No dispute is needed, and nothing was filed. If you spot another payment you do not recognise, tell me.');
  } else {
    await runAgent(record, principal, 'transaction_confirmed', { transaction_id: transactionId });
    decorateAfterRun(record);
  }
  updateCase(record);
  return record;
}

// Re-runs the decision after the customer adds documents (they trigger the verification gate).
export async function redecideAfterDocuments(principal: Principal, record: CaseRecord): Promise<void> {
  if (record.event_type !== 'hospitalization' || !record.decision || !hasConsent(record, READ_CONSENT)) return;
  await runAgent(record, principal, 'documents_updated');
  decorateAfterRun(record);
}

export function requestHandoff(principal: Principal, caseId: string, reason?: string): CaseRecord {
  const record = loadCaseForOwner(principal, caseId, 'case:read');
  if (record.status === 'human_review') return record;
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

export async function confirmBill(
  principal: Principal,
  caseId: string,
  input: { document_id: string; confirmed: boolean; total_inr?: number },
): Promise<CaseRecord> {
  const record = loadCaseForOwner(principal, caseId, 'document:upload');
  const question = record.pending_question;
  if (!question || question.type !== 'confirm_bill' || question.document_id !== input.document_id) {
    throw new HttpError(409, 'This conversation is not waiting for that bill to be confirmed.');
  }
  record.pending_question = null;
  if (!input.confirmed) {
    addTimeline(record, { title: 'Bill total not confirmed', detail: 'Waiting for the customer to give the total.', actor: 'customer' });
    addMessage(record, 'assistant', 'No problem. Please tell me the total amount on the bill, or a specialist can verify it for you.', {
      quick_replies: [{ label: 'Talk to a specialist', action: 'handoff' }],
    });
    if (record.context) record.context.awaiting = 'bill_inr';
    updateCase(record);
    return record;
  }
  const total = input.total_inr ?? question.total_inr;
  // Keep the itemized lines only when they reconcile to the confirmed total; otherwise use one confirmed total line.
  const lineTotal = question.lines.reduce((sum, line) => sum + line.amount_inr, 0);
  const lines: ParsedBillLine[] =
    question.lines.length && lineTotal === total
      ? question.lines
      : [{ line: 1, description: 'Bill total (confirmed by you)', amount_inr: total }];
  record.confirmed_bill = {
    document_id: question.document_id,
    document_name: question.document_name,
    total_inr: total,
    lines,
    confirmed_at: nowIso(),
  };
  addMessage(record, 'user', `Yes, the bill total is ${formatInr(total)}.`);
  addTimeline(record, {
    title: `You confirmed the bill total: ${formatInr(total)}`,
    detail: `${question.document_name}${input.total_inr && input.total_inr !== question.total_inr ? ' (you corrected the amount)' : ''}.`,
    actor: 'customer',
  });
  recordAudit({ case_id: caseId, actor: principal.sub, event: 'bill_confirmed', detail: { document_id: question.document_id, total_inr: total } });
  await continueAfterBillConfirmed(principal, record);
  updateCase(record);
  return record;
}
