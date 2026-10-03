import crypto from 'node:crypto';
import { assertScope } from './auth';
import { findCase, nowIso, recordAudit, updateCase } from './db';
import { HttpError } from './errors';
import type { Actor, CaseRecord, ChatMessage, CaseStatus, ConsentPurpose, EventType, Principal } from './types';

export const EVENT_LABELS: Record<EventType, string> = {
  hospitalization: 'Hospital bill',
  upi_dispute: 'Unrecognized UPI payment',
  emi_shortfall: 'EMI shortfall',
  failed_refund: 'Failed UPI refund',
  protection: 'Life insurance check',
  general_financial_support: 'Money question',
};

export const newId = (prefix: string, length = 8): string =>
  `${prefix}-${crypto.randomUUID().replace(/-/g, '').slice(0, length).toUpperCase()}`;

export function addTimeline(
  record: CaseRecord,
  entry: { status?: CaseStatus; title: string; detail?: string; actor: Actor },
): void {
  if (entry.status) record.status = entry.status;
  record.timeline.push({
    at: nowIso(),
    status: record.status,
    title: entry.title,
    detail: entry.detail ?? '',
    actor: entry.actor,
  });
}

export function addMessage(
  record: CaseRecord,
  role: 'user' | 'assistant',
  content: string,
  extra: Pick<ChatMessage, 'original' | 'language' | 'source' | 'quick_replies' | 'card'> = {},
): void {
  record.messages.push({ role, content, at: nowIso(), ...extra });
  if (role === 'assistant') record.assistant_message = content;
}

export function hasConsent(record: CaseRecord, purpose: ConsentPurpose): boolean {
  const latest = record.consents.filter((consent) => consent.purpose === purpose).at(-1);
  return latest?.status === 'granted';
}

export function grantRecordsConsent(record: CaseRecord, principal: Principal, standing = false): void {
  record.consents.push({ purpose: 'prepare_resolution_options', status: 'granted', granted_at: nowIso(), revoked_at: null, actor: principal.sub });
  recordAudit({ case_id: record.case_id, actor: principal.sub, event: 'consent_granted', detail: { purpose: 'prepare_resolution_options', standing } });
  addTimeline(record, {
    title: standing ? 'Access allowed (remembered choice)' : 'Access allowed',
    detail: `Purpose: prepare options. Saathi may read records relevant to this conversation only.${standing ? ' Turn this off any time in More > Consent management.' : ''}`,
    actor: 'customer',
  });
}

export function loadCaseForRead(principal: Principal, caseId: string): CaseRecord {
  const record = findCase(caseId);
  if (!record) throw new HttpError(404, 'Case not found');
  if (principal.scopes.includes('case:read:any')) return record;
  if (!principal.scopes.includes('case:read') || record.customer_id !== principal.sub) {
    throw new HttpError(404, 'Case not found');
  }
  return record;
}

export function loadCaseForOwner(principal: Principal, caseId: string, scope: string): CaseRecord {
  assertScope(principal, scope);
  const record = findCase(caseId);
  if (!record || record.customer_id !== principal.sub) throw new HttpError(404, 'Case not found');
  return record;
}

export function mutateCase(caseId: string, mutate: (record: CaseRecord) => void): CaseRecord | null {
  const record = findCase(caseId);
  if (!record) return null;
  mutate(record);
  updateCase(record);
  return record;
}

export function supersedePendingActions(record: CaseRecord, reason: string): void {
  for (const action of record.actions) {
    if (action.status === 'awaiting_approval') {
      action.status = 'cancelled';
      addTimeline(record, { title: `Prepared action withdrawn: ${action.title}`, detail: reason, actor: 'saathi' });
    }
  }
}
