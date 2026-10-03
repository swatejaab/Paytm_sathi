import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api';
import { STATUS_FLOW, STATUS_LABELS } from '../format';
import type { CaseRecord, IntegrationStatus } from '../types';
import { AgentView } from './AgentView';
import { AuditView } from './AuditView';
import { EvidenceView } from './EvidenceView';
import { Icon } from './Icon';
import { PassportView } from './PassportView';
import { PlanView } from './PlanView';
import { TimelineView } from './TimelineView';
import { WhyPlan } from './WhyPlan';

export type PanelTab = 'plan' | 'why' | 'evidence' | 'timeline' | 'passport' | 'activity';
const TABS: { id: PanelTab; label: string }[] = [
  { id: 'plan', label: 'Plan' },
  { id: 'why', label: 'Why this plan?' },
  { id: 'evidence', label: 'Sources' },
  { id: 'timeline', label: 'Timeline' },
  { id: 'passport', label: 'Passport' },
  { id: 'activity', label: 'Activity' },
];

interface Props {
  caseRecord: CaseRecord;
  onChange: (record: CaseRecord) => void;
  integrations: IntegrationStatus;
  readOnly: boolean;
  tab?: PanelTab;
  onTabChange?: (tab: PanelTab) => void;
  onClose?: () => void;
}

export function hasActiveConsent(record: CaseRecord): boolean {
  return record.consents.filter((consent) => consent.purpose === 'prepare_resolution_options').at(-1)?.status === 'granted';
}

function StatusStepper({ status }: { status: CaseRecord['status'] }) {
  const isHuman = status === 'human_review';
  const currentIndex = STATUS_FLOW.indexOf(status);
  return (
    <ol className="stepper" aria-label="Progress">
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
          <span className="step-label">With a specialist</span>
        </li>
      )}
    </ol>
  );
}

export function CasePanel({ caseRecord, onChange, integrations, readOnly, tab: controlledTab, onTabChange, onClose }: Props) {
  const [localTab, setLocalTab] = useState<PanelTab>('plan');
  const tab = controlledTab ?? localTab;
  const setTab = (next: PanelTab) => (onTabChange ? onTabChange(next) : setLocalTab(next));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setError(null), [caseRecord.case_id]);

  const run = async (operation: () => Promise<CaseRecord>) => {
    setBusy(true);
    setError(null);
    try {
      onChange(await operation());
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const canEscalate = !readOnly && !['resolved', 'human_review', 'in_progress'].includes(caseRecord.status);

  return (
    <section className="case-panel">
      <header className="case-head">
        <div>
          <span className={`badge badge-status status-${caseRecord.status}`}>{STATUS_LABELS[caseRecord.status]}</span>
          <h2>{caseRecord.title ?? 'Your plan'}</h2>
        </div>
        <div className="row gap-sm">
          {canEscalate && (
            <button className="btn btn-sm btn-ghost" disabled={busy} onClick={() => run(() => api.handoff(caseRecord.case_id))}>
              Talk to a specialist
            </button>
          )}
          {onClose && (
            <button className="icon-btn" onClick={onClose} aria-label="Close plan">
              <Icon name="close" />
            </button>
          )}
        </div>
      </header>

      <StatusStepper status={caseRecord.status} />

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
        {tab === 'why' &&
          (caseRecord.decision ? (
            <WhyPlan decision={caseRecord.decision} />
          ) : (
            <p className="muted">Saathi explains its recommendation here once it has a plan for you.</p>
          ))}
        {tab === 'evidence' && <EvidenceView caseRecord={caseRecord} integrations={integrations} readOnly={readOnly} busy={busy} run={run} />}
        {tab === 'timeline' && <TimelineView caseRecord={caseRecord} />}
        {tab === 'passport' && <PassportView caseRecord={caseRecord} />}
        {tab === 'activity' && (
          <>
            <AgentView caseRecord={caseRecord} />
            <AuditView caseRecord={caseRecord} />
          </>
        )}
      </div>
    </section>
  );
}
