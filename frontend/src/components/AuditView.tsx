import { useEffect, useState } from 'react';
import { api } from '../api';
import { timeOnly } from '../format';
import type { AuditEvent, CaseRecord } from '../types';

const EVENT_LABELS: Record<string, string> = {
  mcp_tool_call: 'Saathi read or prepared information',
  consent_granted: 'You gave permission',
  consent_revoked: 'You withdrew permission',
  action_prepared: 'Action prepared for your review',
  action_approved: 'You approved an action',
  action_cancelled: 'You cancelled an action',
  partner_event: 'Partner update (simulated)',
  document_uploaded: 'Document added',
  handoff_requested: 'Specialist requested',
  conversation_renamed: 'Conversation renamed',
  case_created: 'Conversation started',
};

function describe(event: AuditEvent): string {
  const detail = event.detail;
  if (event.decision === 'deny' && typeof detail.reason === 'string') return detail.reason;
  if (event.event === 'partner_event') return String(detail.status ?? '');
  if (event.event === 'document_uploaded') return `${String(detail.document_type)} (contents are never logged)`;
  if (typeof detail.purpose === 'string') return detail.purpose.replace(/_/g, ' ');
  return '';
}

export function AuditView({ caseRecord }: { caseRecord: CaseRecord }) {
  const [events, setEvents] = useState<AuditEvent[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .audit(caseRecord.case_id)
      .then((result) => !cancelled && setEvents(result.events))
      .catch(() => !cancelled && setEvents([]));
    return () => {
      cancelled = true;
    };
  }, [caseRecord.case_id, caseRecord.updated_at]);

  const denied = events.filter((event) => event.decision === 'deny').length;

  return (
    <section className="audit">
      <h3>Access log</h3>
      <p className="muted small">
        Every time Saathi reads your records or prepares an action, it checks your identity, this conversation, your permission, and your
        approval. {denied ? `${denied} request(s) were blocked.` : 'Nothing was blocked.'} Document contents and keys are never logged.
      </p>
      {events.length === 0 ? (
        <p className="muted">No activity yet.</p>
      ) : (
        <ul className="audit-list">
          {events.map((event) => (
            <li key={event.id}>
              <small className="muted">{timeOnly(event.at)}</small>
              <span>
                {EVENT_LABELS[event.event] ?? event.event.replace(/_/g, ' ')}
                {describe(event) && <small className="muted"> · {describe(event)}</small>}
              </span>
              <span className={`badge decision-${event.decision}`}>{event.decision === 'deny' ? 'Blocked' : event.decision === 'allow' ? 'Allowed' : 'Info'}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
