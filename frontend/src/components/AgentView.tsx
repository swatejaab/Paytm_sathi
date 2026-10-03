import { useState } from 'react';
import { timeOnly } from '../format';
import type { AgentRun, CaseRecord } from '../types';

const TRIGGER_LABELS: Record<string, string> = {
  intake: 'You shared your situation',
  details_updated: 'You added details',
  consent_granted: 'You allowed access to your records',
  transaction_confirmed: 'You flagged a payment',
  documents_updated: 'You added documents',
  action_prepared: 'You chose an option',
  action_approved: 'You approved the action',
};

const OUTCOME_LABELS: Record<string, string> = {
  awaiting_consent: 'Waiting for your permission',
  awaiting_transaction: 'Waiting for you',
  routed_to_specialist: 'Sent to a specialist',
  options_ready: 'Options ready',
};

function RunCard({ run, open, onToggle }: { run: AgentRun; open: boolean; onToggle: () => void }) {
  const failed = run.steps.some((step) => step.status === 'error');
  return (
    <li className="agent-run card-inset">
      <button className="agent-run-head" onClick={onToggle} aria-expanded={open}>
        <span>
          <strong>{TRIGGER_LABELS[run.trigger] ?? 'Saathi updated your plan'}</strong>
          <small className="muted"> · {timeOnly(run.started_at)}</small>
        </span>
        <span className={`badge ${failed ? 'badge-red' : run.outcome.startsWith('awaiting') ? 'badge-amber' : 'badge-green'}`}>
          {OUTCOME_LABELS[run.outcome] ?? run.outcome.replace(/_/g, ' ')}
        </span>
      </button>
      {open && (
        <ol className="agent-steps">
          {run.steps.map((step, index) => (
            <li key={`${step.node}-${index}`} className={`agent-step agent-step-${step.status}`}>
              <span className="agent-step-dot" aria-hidden />
              <div className="agent-step-body">
                <strong>{step.label}</strong>
                <p className="small">{step.summary}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}

export function AgentView({ caseRecord }: { caseRecord: CaseRecord }) {
  const runs = [...(caseRecord.agent_runs ?? [])].reverse();
  const [openRun, setOpenRun] = useState<string | null>(null);
  const expanded = openRun ?? runs[0]?.run_id ?? null;

  return (
    <section className="agents">
      <h3>How Saathi worked on this</h3>
      <p className="muted small">
        AI helps understand your situation and explain options. Fixed rules do every calculation, and only you can approve an action.
      </p>
      {runs.length === 0 ? (
        <p className="muted">Steps appear here as soon as Saathi starts working on your request.</p>
      ) : (
        <ol className="agent-runs">
          {runs.map((run) => (
            <RunCard key={run.run_id} run={run} open={expanded === run.run_id} onToggle={() => setOpenRun(expanded === run.run_id ? '' : run.run_id)} />
          ))}
        </ol>
      )}
    </section>
  );
}
