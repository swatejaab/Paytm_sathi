import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage, loadSession } from '../api';
import { EVENT_LABELS, relativeTime, STATUS_LABELS } from '../format';
import type { CaseRecord, CaseSummary, IntegrationStatus } from '../types';
import { CasePanel } from './CasePanel';
import { SpecialistDesk } from './SpecialistDesk';
import { EmptyState } from './ui';

const READ_ONLY_INTEGRATIONS: IntegrationStatus = {
  openai_available: false,
  sarvam_available: false,
  n8n_configured: false,
  partner_channel: 'local_mock',
  knowledge_backend: 'local_index',
  lender_adapter: 'local',
};

export function SupportQueue() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [active, setActive] = useState<CaseRecord | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = loadSession()?.user ?? null;

  const refresh = useCallback(async () => {
    try {
      setCases((await api.supportCases()).cases);
      setError(null);
    } catch (caught) {
      setError(errorMessage(caught));
    }
  }, []);

  const update = useCallback(
    (record: CaseRecord) => {
      setActive(record);
      void refresh();
    },
    [refresh],
  );

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const open = async (caseId: string) => {
    try {
      setActive(await api.getCase(caseId));
    } catch (caught) {
      setError(errorMessage(caught));
    }
  };

  return (
    <main className="page support">
      <section className="support-queue">
        <h1>Support queue</h1>
        <p className="muted small">
          Pick up a case, verify documents, message the customer, and recommend a path from the same Resolution Passport. Only the customer can
          approve partner actions.
        </p>
        {error && <p className="alert alert-error">{error}</p>}
        <div className="queue">
          {cases.length === 0 && <p className="muted">No cases yet.</p>}
          {cases.map((item) => (
            <button
              key={item.case_id}
              className={`queue-item ${active?.case_id === item.case_id ? 'selected' : ''} ${item.status === 'human_review' ? 'needs-human' : ''}`}
              onClick={() => void open(item.case_id)}
            >
              <div className="row space-between gap-sm">
                <strong>{item.title}</strong>
                <span className={`badge badge-status status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
              </div>
              <span className="small">{EVENT_LABELS[item.event_type]}</span>
              <small className="muted">Updated {relativeTime(item.updated_at).toLowerCase()}</small>
            </button>
          ))}
        </div>
        {active && <SpecialistDesk caseRecord={active} user={user} onChange={update} />}
      </section>
      <section className="support-case card">
        {active ? (
          <CasePanel caseRecord={active} onChange={setActive} integrations={READ_ONLY_INTEGRATIONS} readOnly />
        ) : (
          <EmptyState icon="folder" title="Select a case" body="The customer's plan, sources, and timeline appear here." />
        )}
      </section>
    </main>
  );
}
