import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { dateTime, EVENT_LABELS, STATUS_LABELS } from '../format';
import type { CaseRecord, CaseSummary, IntegrationStatus } from '../types';
import { CasePanel } from './CasePanel';

const NO_INTEGRATIONS: IntegrationStatus = {
  openai_available: false,
  sarvam_available: false,
  n8n_configured: false,
  partner_channel: 'local_mock',
  knowledge_backend: 'local_index',
  lender_adapter: 'synthetic_fixture',
};

export function SupportQueue() {
  const [cases, setCases] = useState<CaseSummary[]>([]);
  const [active, setActive] = useState<CaseRecord | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setCases((await api.supportCases()).cases);
      setError(null);
    } catch {
      setError('Could not load the support queue.');
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(refresh, 10000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  return (
    <main className="workspace">
      <section className="conversation">
        <p className="eyebrow">Specialist desk</p>
        <h1>Support queue</h1>
        <p className="muted">
          Specialists continue from the customer's Resolution Passport. They have read-only access and cannot approve
          customer actions.
        </p>
        {error && <p className="alert alert-error">{error}</p>}
        <div className="queue">
          {cases.length === 0 && <p className="muted">No cases yet. Sign in as a demo customer and open a journey.</p>}
          {cases.map((item) => (
            <button
              key={item.case_id}
              className={`queue-item ${active?.case_id === item.case_id ? 'selected' : ''} ${item.status === 'human_review' ? 'needs-human' : ''}`}
              onClick={async () => setActive(await api.getCase(item.case_id))}
            >
              <div className="row space-between">
                <strong>{item.case_id}</strong>
                <span className={`badge status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
              </div>
              <span>
                {EVENT_LABELS[item.event_type]} / {item.customer_id}
              </span>
              <small className="muted">"{item.customer_message}"</small>
              <small className="muted">Updated {dateTime(item.updated_at)}</small>
            </button>
          ))}
        </div>
      </section>
      <CasePanel caseRecord={active} onChange={setActive} integrations={NO_INTEGRATIONS} readOnly />
    </main>
  );
}
