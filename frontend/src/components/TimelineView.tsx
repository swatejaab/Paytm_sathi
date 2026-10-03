import { STATUS_LABELS, timeOnly } from '../format';
import type { CaseRecord } from '../types';

const ACTOR_LABELS: Record<string, string> = {
  customer: 'You',
  saathi: 'Saathi',
  partner: 'Partner',
  support: 'Specialist',
  system: 'System',
};

export function TimelineView({ caseRecord }: { caseRecord: CaseRecord }) {
  return (
    <div>
      {caseRecord.status === 'in_progress' && (
        <p className="alert alert-info">
          <span className="live-dot" /> Live. Partner updates (simulated) appear here as they arrive.
        </p>
      )}
      <ol className="timeline">
        {[...caseRecord.timeline].reverse().map((entry, index) => (
          <li key={`${entry.at}-${index}`} className={`timeline-item actor-${entry.actor}`}>
            <span className="timeline-dot" />
            <div>
              <div className="row gap-sm wrap">
                <strong>{entry.title}</strong>
                <span className="badge">{STATUS_LABELS[entry.status]}</span>
              </div>
              {entry.detail && <p className="muted small">{entry.detail}</p>}
              <small className="muted">
                {timeOnly(entry.at)} / {ACTOR_LABELS[entry.actor] ?? entry.actor}
              </small>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}
