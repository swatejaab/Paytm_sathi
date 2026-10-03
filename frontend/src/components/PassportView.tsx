import { useEffect, useState } from 'react';
import { api } from '../api';
import { EVENT_LABELS, factValue, inr, sourceLabel } from '../format';
import { passportSummary, printPassport } from '../passportPrint';
import type { CaseRecord, Passport } from '../types';

export function PassportView({ caseRecord }: { caseRecord: CaseRecord }) {
  const [passport, setPassport] = useState<Passport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareNote, setShareNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .passport(caseRecord.case_id)
      .then((result) => !cancelled && setPassport(result))
      .catch(() => !cancelled && setError('Could not load the passport.'));
    return () => {
      cancelled = true;
    };
  }, [caseRecord.case_id, caseRecord.updated_at]);

  if (error) return <p className="alert alert-error">{error}</p>;
  if (!passport) return <p className="muted">Loading passport...</p>;

  const download = () => {
    const blob = new Blob([JSON.stringify(passport, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${passport.passport_id}.json`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="passport">
      <div className="passport-card">
        <div className="row space-between">
          <div>
            <p className="eyebrow">Resolution Passport</p>
            <h3>{passport.passport_id}</h3>
          </div>
          <div className="row gap-sm wrap">
            <button
              className="btn btn-primary"
              onClick={() => setShareNote(printPassport(passport) ? null : 'Allow pop-ups for this site to download the PDF.')}
            >
              Download PDF
            </button>
            <button
              className="btn"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(passportSummary(passport));
                  setShareNote('Summary copied. Paste it into WhatsApp, email, or a hospital desk chat.');
                } catch {
                  setShareNote('Copy is blocked in this browser; use Download PDF instead.');
                }
              }}
            >
              Copy summary
            </button>
            <button className="btn btn-ghost" onClick={download}>
              JSON
            </button>
          </div>
        </div>
        {shareNote && <p className="alert alert-info">{shareNote}</p>}
        <p className="muted small">
          Tell it once. Every approved insurer, payment, lending, or specialist step reuses this same packet.
        </p>
        <dl className="passport-grid">
          <dt>Event</dt>
          <dd>
            {EVENT_LABELS[passport.event.type]} / {passport.event.urgency} urgency
          </dd>
          <dt>Your words</dt>
          <dd>"{passport.story}"</dd>
          {passport.calculation && (
            <>
              <dt>Exact gap</dt>
              <dd>
                {inr(passport.calculation.bill_total_inr)} − {inr(passport.calculation.coverage_estimate_inr)} −{' '}
                {inr(passport.calculation.customer_contribution_inr)} = <strong>{inr(passport.calculation.exact_gap_inr)}</strong>
              </dd>
            </>
          )}
          {passport.transaction && (
            <>
              <dt>Transaction</dt>
              <dd>
                {passport.transaction.transaction_id} / {inr(passport.transaction.amount_inr)} to {passport.transaction.counterparty}
              </dd>
            </>
          )}
          {passport.recommended_option && (
            <>
              <dt>Recommended</dt>
              <dd>{passport.recommended_option}</dd>
            </>
          )}
          <dt>Documents</dt>
          <dd>
            {passport.documents.length
              ? passport.documents.map((document) => `${document.document_name} (${document.origin.replace('_', ' ')})`).join(', ')
              : 'None yet'}
          </dd>
          {passport.missing_documents.length > 0 && (
            <>
              <dt>Missing</dt>
              <dd>{passport.missing_documents.join(', ')}</dd>
            </>
          )}
          <dt>Consent</dt>
          <dd>
            {passport.consents.length
              ? passport.consents.map((consent) => `${consent.purpose.replace(/_/g, ' ')}: ${consent.status}`).join('; ')
              : 'Not granted'}
          </dd>
        </dl>
        {passport.facts.length > 0 && (
          <>
            <h4>Source trail</h4>
            <ul className="source-trail">
              {passport.facts.map((fact, index) => (
                <li key={`${fact.name}-${index}`}>
                  <strong>{fact.label}:</strong> {factValue(fact)} <span className="muted">from {sourceLabel(fact.source)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
        <p className="muted small">{passport.notice}</p>
      </div>
    </div>
  );
}
