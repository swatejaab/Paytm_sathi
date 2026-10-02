import { runAgent } from './agent/graph';
import { addMessage, addTimeline, hasConsent, loadCaseForOwner, newId, supersedePendingActions } from './caseStore';
import { insertCase, nowIso, recordAudit, updateCase } from './db';
import { HttpError } from './errors';
import type { CaseRecord, Principal } from './types';

const READ_CONSENT = 'prepare_resolution_options' as const;

// Case workflow entry points. The bounded agent graph (agent/graph.ts) does the work;
// the persisted case record is its durable checkpoint, so each trigger resumes the right case.

export async function createCase(principal: Principal, message: string, consentGranted: boolean): Promise<CaseRecord> {
  const now = nowIso();
  const record: CaseRecord = {
    case_id: newId('SA'),
    customer_id: principal.sub,
    event_type: 'general_financial_support',
    urgency: 'low',
    language: 'en',
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
    agent_runs: [],
  };
  addMessage(record, 'user', record.customer_message);
  insertCase(record);
  await runAgent(record, principal, 'intake', consentGranted ? { grantConsent: () => grantConsentRecord(record, principal) } : {});
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

export async function setConsent(principal: Principal, caseId: string, granted: boolean): Promise<CaseRecord> {
  const record = loadCaseForOwner(principal, caseId, 'consent:manage');
  const current = hasConsent(record, READ_CONSENT);
  if (granted && !current) {
    grantConsentRecord(record, principal);
    if (record.status === 'intake') await runAgent(record, principal, 'consent_granted');
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

export async function confirmTransaction(
  principal: Principal,
  caseId: string,
  transactionId: string,
  recognized: boolean,
): Promise<CaseRecord> {
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
  } else {
    await runAgent(record, principal, 'transaction_confirmed', { transaction_id: transactionId });
  }
  updateCase(record);
  return record;
}

// Re-runs the decision after the customer adds documents (they trigger the verification gate).
export async function redecideAfterDocuments(principal: Principal, record: CaseRecord): Promise<void> {
  if (record.event_type !== 'hospitalization' || !record.decision || !hasConsent(record, READ_CONSENT)) return;
  await runAgent(record, principal, 'documents_updated');
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
