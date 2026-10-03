import { useEffect, useState } from 'react';
import { api, ApiError, streamCase } from '../api';
import { EVENT_LABELS, STATUS_FLOW, STATUS_LABELS } from '../format';
import type { CaseRecord, IntegrationStatus } from '../types';
import { AgentView } from './AgentView';
import { AuditView } from './AuditView';
import { EvidenceView } from './EvidenceView';
import { PassportView } from './PassportView';
import { PlanView } from './PlanView';
import { TimelineView } from './TimelineView';

type Tab = 'plan' | 'evidence' | 'agents' | 'timeline' | 'passport' | 'audit';
const TABS: { id: Tab; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'evidence', label: 'Evidence' },
  { id: 'agents', label: 'Agents' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'passport', label: 'Passport' },
  { id: 'audit', label: 'Trust ledger' },
];

interface Props {
  caseRecord: CaseRecord | null;
  onChange: (record: CaseRecord) => void;
  integrations: IntegrationStatus;
  readOnly: boolean;
}

export function hasActiveConsent(record: CaseRecord): boolean {
  return record.consents.filter((consent) => consent.purpose === 'prepare_resolution_options').at(-1)?.status === 'granted';
}

function StatusStepper({ status }: { status: CaseRecord['status'] }) {
  const isHuman = status === 'human_review';
  const currentIndex = STATUS_FLOW.indexOf(status);
  return (
    <ol className="stepper" aria-label="Case status">
      {STATUS_FLOW.map((step, index) => {
        const state = isHuman ? 'todo' : index < currentIndex ? 'done' : index === currentIndex ? 'current' : 'todo';
        return (
          <li key={step} className={`step step-${state}`}>
            <span className="step-dot" />
            <span className="step-label">{STATUS_LABELS[step]}</span>
          </li>
        );
      })}
      {isHuman && (
        <li className="step step-human">
          <span className="step-dot" />
          <span className="step-label">Human review</span>
        </li>
      )}
    </ol>
  );
}

export function CasePanel({ caseRecord, onChange, integrations, readOnly }: Props) {
  const [tab, setTab] = useState<Tab>('plan');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
  }, [caseRecord?.case_id]);

  const caseId = caseRecord?.case_id;
  const status = caseRecord?.status;
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    streamCase(caseId, onChange, controller.signal)
      .catch(() => undefined)
      .finally(() => setLive(false));
    setLive(true);
    return () => controller.abort();
  }, [caseId, onChange]);

  // Fallback when the live stream is unavailable (for example behind a buffering proxy).
  useEffect(() => {
    if (live || !caseId || status !== 'in_progress') return;
    const timer = window.setInterval(async () => {
      try {
        onChange(await api.getCase(caseId));
      } catch {
        // polling resumes on the next tick
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [live, caseId, status, onChange]);

  const run = async (operation: () => Promise<CaseRecord>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await operation());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. No financial action was started.');
    } finally {
      setBusy(false);
    }
  };

  if (!caseRecord) {
    return (
      <section className="case-panel card empty-state">
        <p className="eyebrow">Here's your clear path</p>
        <h2>Your case appears here.</h2>
        <p className="muted">
          Start with the hospital demo. Saathi gathers the bill, policy clauses, and your cash context, calculates the exact
          funding gap, and compares every path side by side before anything happens.
        </p>
        <ul className="feature-list">
          <li>Every fact links to a bill line, policy clause, or named calculation.</li>
          <li>Deterministic rules calculate the numbers; the AI never does the maths.</li>
          <li>Nothing reaches a partner until you approve the exact steps and amounts.</li>
        </ul>
      </section>
    );
  }

  const consented = hasActiveConsent(caseRecord);
  const canEscalate = !readOnly && !['resolved', 'human_review', 'in_progress'].includes(caseRecord.status);

  return (
    <section className="case-panel card">
      <header className="case-head">
        <div>
          <div className="row gap-sm wrap">
            <span className="badge badge-blue">{caseRecord.case_id}</span>
            <span className={`badge badge-status status-${caseRecord.status}`}>{STATUS_LABELS[caseRecord.status]}</span>
            <span className={`badge urgency-${caseRecord.urgency}`}>{caseRecord.urgency} urgency</span>
          </div>
          <h2>{EVENT_LABELS[caseRecord.event_type]}</h2>
        </div>
        {canEscalate && (
          <button className="btn btn-ghost" disabled={busy} onClick={() => run(() => api.handoff(caseRecord.case_id))}>
            Talk to a human
          </button>
        )}
      </header>

      <StatusStepper status={caseRecord.status} />

      {!consented && !readOnly && caseRecord.status === 'intake' && (
        <div className="alert alert-info consent-banner">
          <div>
            <strong>Consent needed to continue.</strong> Saathi saved your story but has not read any records. Grant
            purpose-bound consent to gather evidence and compare options.
          </div>
          <button className="btn btn-primary" disabled={busy} onClick={() => run(() => api.setConsent(caseRecord.case_id, true))}>
            Grant consent
          </button>
        </div>
      )}

      {error && <p className="alert alert-error">{error}</p>}

      <nav className="tabs" role="tablist">
        {TABS.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={tab === item.id}
            className={`tab ${tab === item.id ? 'active' : ''}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
            {item.id === 'timeline' && caseRecord.status === 'in_progress' && <span className="live-dot" title="Live" />}
          </button>
        ))}
      </nav>

      <div className="tab-body">
        {tab === 'plan' && <PlanView caseRecord={caseRecord} busy={busy} readOnly={readOnly} run={run} />}
        {tab === 'evidence' && (
          <EvidenceView caseRecord={caseRecord} integrations={integrations} readOnly={readOnly} busy={busy} run={run} />
        )}
        {tab === 'agents' && <AgentView caseRecord={caseRecord} />}
        {tab === 'timeline' && <TimelineView caseRecord={caseRecord} />}
        {tab === 'passport' && <PassportView caseRecord={caseRecord} />}
        {tab === 'audit' && <AuditView caseRecord={caseRecord} />}
      </div>
    </section>
  );
}
