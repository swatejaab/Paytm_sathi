import { useEffect, useState } from 'react';
import { api, ApiError, streamCase } from '../api';
import { AgentView } from '../components/AgentView';
import { AuditView } from '../components/AuditView';
import { hasActiveConsent } from '../components/CasePanel';
import { EvidenceView } from '../components/EvidenceView';
import { PassportView } from '../components/PassportView';
import { PlanView } from '../components/PlanView';
import { TimelineView } from '../components/TimelineView';
import { EVENT_LABELS, STATUS_FLOW, STATUS_LABELS } from '../format';
import type { CaseRecord, IntegrationStatus } from '../types';
import { Icon } from './Icon';

type Tab = 'plan' | 'proof' | 'track' | 'more';
type More = 'passport' | 'agents' | 'ledger';

interface Props {
  caseRecord: CaseRecord;
  integrations: IntegrationStatus;
  onChange: (record: CaseRecord) => void;
  onClose: () => void;
}

export function MobileCase({ caseRecord, integrations, onChange, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('plan');
  const [more, setMore] = useState<More>('passport');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    streamCase(caseRecord.case_id, onChange, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [caseRecord.case_id, onChange]);

  const run = async (operation: () => Promise<CaseRecord>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await operation());
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Something went wrong. Nothing was submitted.');
    } finally {
      setBusy(false);
    }
  };

  const human = caseRecord.status === 'human_review';
  const step = Math.max(STATUS_FLOW.indexOf(caseRecord.status), 0);
  const progress = human ? 100 : Math.round((step / (STATUS_FLOW.length - 1)) * 100);
  const live = caseRecord.status === 'in_progress';

  return (
    <div className="m-case">
      <header className="m-case-head">
        <button className="m-icon-btn" onClick={onClose} aria-label="Back">
          <Icon name="back" />
        </button>
        <div className="m-case-title">
          <strong>{EVENT_LABELS[caseRecord.event_type]}</strong>
          <small>
            {caseRecord.case_id} · {STATUS_LABELS[caseRecord.status]}
            {live && <span className="m-live" />}
          </small>
        </div>
      </header>
      <div className={`m-progress-bar ${human ? 'human' : ''}`}>
        <span style={{ width: `${progress}%` }} />
      </div>

      <nav className="m-segment" role="tablist">
        {(['plan', 'proof', 'track', 'more'] as Tab[]).map((id) => (
          <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
            {id === 'plan' ? 'Plan' : id === 'proof' ? 'Proof' : id === 'track' ? 'Track' : 'More'}
          </button>
        ))}
      </nav>

      <div className="m-case-body">
        {!hasActiveConsent(caseRecord) && caseRecord.status === 'intake' && (
          <div className="m-consent-card">
            <Icon name="lock" size={22} />
            <div>
              <strong>Saathi needs your OK</strong>
              <small>Allow it to read this case's records to build your plan.</small>
            </div>
            <button className="m-btn primary small" disabled={busy} onClick={() => run(() => api.setConsent(caseRecord.case_id, true))}>
              Allow
            </button>
          </div>
        )}
        {error && <p className="m-error inline">{error}</p>}

        {tab === 'plan' && <PlanView caseRecord={caseRecord} busy={busy} readOnly={false} run={run} />}
        {tab === 'proof' && <EvidenceView caseRecord={caseRecord} integrations={integrations} readOnly={false} busy={busy} run={run} />}
        {tab === 'track' && <TimelineView caseRecord={caseRecord} />}
        {tab === 'more' && (
          <>
            <div className="m-subtabs">
              {(['passport', 'agents', 'ledger'] as More[]).map((id) => (
                <button key={id} className={more === id ? 'active' : ''} onClick={() => setMore(id)}>
                  {id === 'passport' ? 'Case summary' : id === 'agents' ? 'How Saathi worked' : 'Activity log'}
                </button>
              ))}
            </div>
            <p className="m-more-intro">
              {more === 'passport'
                ? 'Your case summary in one place. Share it with the hospital, insurer or a specialist so you never repeat your story.'
                : more === 'agents'
                  ? 'Step by step, how Saathi worked on your case: what it checked, which records it read, and how long each step took.'
                  : 'A record of every action on your case: what was allowed, what was blocked, and what you approved.'}
            </p>
            {more === 'passport' && <PassportView caseRecord={caseRecord} />}
            {more === 'agents' && <AgentView caseRecord={caseRecord} />}
            {more === 'ledger' && <AuditView caseRecord={caseRecord} />}
            {!['resolved', 'human_review', 'in_progress'].includes(caseRecord.status) && (
              <button className="m-btn ghost" disabled={busy} onClick={() => run(() => api.handoff(caseRecord.case_id))}>
                <Icon name="headset" size={18} /> Talk to a human
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
