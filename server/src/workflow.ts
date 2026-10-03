import { runAgent } from './agent/graph';
import { addMessage, addTimeline, hasConsent, loadCaseForOwner, newId, supersedePendingActions } from './caseStore';
import { insertCase, nowIso, recordAudit, standingConsents, updateCase } from './db';
import { HttpError } from './errors';
import type { CaseRecord, ParsedBillLine, Principal } from './types';

const READ_CONSENT = 'prepare_resolution_options' as const;

// Case workflow entry points. The bounded agent graph (agent/graph.ts) does the work;
// the persisted case record is its durable checkpoint, so each trigger resumes the right case.

export async function createCase(
  principal: Principal,
  message: string,
  consentGranted: boolean,
  preferredLanguage?: string,
  aiAnswers = false,
  background = false,
): Promise<CaseRecord> {
  const now = nowIso();
  const record: CaseRecord = {
    case_id: newId('SA'),
    customer_id: principal.sub,
    event_type: 'general_financial_support',
    urgency: 'low',
    language: 'en',
    ...(preferredLanguage ? { preferred_language: preferredLanguage } : {}),
    ...(aiAnswers ? { ai_answers: true } : {}),
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
  // A remembered "records" consent applies to new cases; it is still recorded on this case and revocable.
  const standing = !consentGranted && standingConsents(principal.sub).records;
  const consent = consentGranted || standing ? { grantConsent: () => grantConsentRecord(record, principal, standing) } : {};
  if (background) {
    // Live mode: answer now and let the customer watch each agent step arrive over the case's event stream.
    const save = () => {
      try {
        updateCase(record);
      } catch {
        // the case was deleted mid-run; nothing left to update
      }
    };
    void runAgent(record, principal, 'intake', { ...consent, onProgress: save })
      .catch((error: unknown) => console.error(`[saathi] agent run failed for ${record.case_id}:`, error))
      .finally(save);
    return structuredClone(record);
  }
  await runAgent(record, principal, 'intake', consent);
  updateCase(record);
  return record;
}

function grantConsentRecord(record: CaseRecord, principal: Principal, standing = false): void {
  record.consents.push({ purpose: READ_CONSENT, status: 'granted', granted_at: nowIso(), revoked_at: null, actor: principal.sub });
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'consent_granted', detail: { purpose: READ_CONSENT, standing } });
  addTimeline(record, {
    title: standing ? 'Consent applied (remembered choice)' : 'Consent granted',
    detail: `Purpose: prepare resolution options. Saathi reads only the records relevant to this case.${standing ? ' Turn this off any time in Profile.' : ''}`,
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

  const picked = question.candidates.find((candidate) => candidate.transaction_id === transactionId)!;
  const label = `₹${picked.amount_inr.toLocaleString('en-IN')} to ${picked.counterparty}`;
  addMessage(
    record,
    'user',
    question.mode === 'select' ? `It's the ${label} payment.` : recognized ? `I made the ${label} payment.` : `I did not make the ${label} payment.`,
  );
  record.pending_question = null;

  if (recognized && question.mode !== 'select') {
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

export async function confirmBill(
  principal: Principal,
  caseId: string,
  input: { document_id: string; confirmed: boolean; total_inr?: number },
): Promise<CaseRecord> {
  const record = loadCaseForOwner(principal, caseId, 'document:upload');
  const question = record.pending_question;
  if (!question || question.type !== 'confirm_bill' || question.document_id !== input.document_id) {
    throw new HttpError(409, 'This case is not waiting for that bill to be confirmed.');
  }
  record.pending_question = null;
  if (!input.confirmed) {
    addTimeline(record, { title: 'Bill total not confirmed', detail: 'A specialist will verify the bill instead.', actor: 'customer' });
    addMessage(record, 'assistant', 'No problem. I will keep the bill aside for a specialist to verify; automated steps stay paused.');
    await runAgent(record, principal, 'documents_updated');
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
  addMessage(record, 'user', `Yes, the bill total is INR ${total.toLocaleString('en-IN')}.`);
  addTimeline(record, {
    title: `You confirmed the bill total: INR ${total.toLocaleString('en-IN')}`,
    detail: `${question.document_name}${input.total_inr && input.total_inr !== question.total_inr ? ' (you corrected the amount)' : ''}.`,
    actor: 'customer',
  });
  recordAudit({ case_id: caseId, actor: principal.sub, event: 'bill_confirmed', detail: { document_id: question.document_id, total_inr: total } });
  await runAgent(record, principal, 'documents_updated');
  updateCase(record);
  return record;
}
