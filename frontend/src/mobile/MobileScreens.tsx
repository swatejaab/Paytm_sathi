import { useEffect, useState } from 'react';
import { api } from '../api';
import { AffordCard } from '../components/AffordCard';
import { CreditScoreCard } from '../components/CreditScoreCard';
import { ForecastCard } from '../components/ForecastCard';
import { EVENT_LABELS, LANGUAGES, STATUS_LABELS } from '../format';
import type { CaseSummary, EventType, SessionUser } from '../types';
import { Icon, type IconName } from './Icon';
import { initials } from './MobileLogin';

export type InsightSection = 'forecast' | 'afford' | 'credit';

export function MobileInsights({ section, onSection, onAsk }: { section: InsightSection; onSection: (value: InsightSection) => void; onAsk: (message: string) => void }) {
  return (
    <div className="m-page">
      <header className="m-topbar">
        <div>
          <strong>Insights</strong>
          <small>Plan ahead, decide with confidence</small>
        </div>
      </header>
      <nav className="m-segment">
        <button className={section === 'forecast' ? 'active' : ''} onClick={() => onSection('forecast')}>
          Cash flow
        </button>
        <button className={section === 'afford' ? 'active' : ''} onClick={() => onSection('afford')}>
          Afford?
        </button>
        <button className={section === 'credit' ? 'active' : ''} onClick={() => onSection('credit')}>
          Credit score
        </button>
      </nav>
      <div className="m-page-body">{section === 'forecast' ? <ForecastCard onAsk={onAsk} /> : section === 'afford' ? <AffordCard /> : <CreditScoreCard />}</div>
    </div>
  );
}

const EVENT_ICON: Record<EventType, IconName> = {
  hospitalization: 'hospital',
  upi_dispute: 'shield',
  failed_refund: 'refund',
  emi_shortfall: 'calendar',
  general_financial_support: 'headset',
};

export function MobileActivity({ onOpen, refreshKey }: { onOpen: (caseId: string) => void; refreshKey: string }) {
  const [cases, setCases] = useState<CaseSummary[] | null>(null);
  useEffect(() => {
    api
      .listCases()
      .then((result) => setCases(result.cases))
      .catch(() => setCases([]));
  }, [refreshKey]);

  return (
    <div className="m-page">
      <header className="m-topbar">
        <div>
          <strong>Activity</strong>
          <small>Your cases, claims and requests</small>
        </div>
      </header>
      <div className="m-page-body">
        {cases === null && <p className="m-muted">Loading…</p>}
        {cases?.length === 0 && (
          <div className="m-empty">
            <Icon name="folder" size={34} />
            <p>No cases yet. Ask Saathi when something comes up.</p>
          </div>
        )}
        <ul className="m-cases">
          {cases?.map((item) => (
            <li key={item.case_id}>
              <button onClick={() => onOpen(item.case_id)}>
                <span className={`m-service-icon small tone-${item.status === 'resolved' ? 'green' : item.status === 'human_review' ? 'amber' : 'blue'}`}>
                  <Icon name={EVENT_ICON[item.event_type]} size={18} />
                </span>
                <span className="m-list-text">
                  <strong>{EVENT_LABELS[item.event_type]}</strong>
                  <small>{new Date(item.updated_at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })} · {item.case_id}</small>
                </span>
                <span className={`m-status status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

interface ProfileProps {
  user: SessionUser;
  onLogout: () => void;
  onWebView: () => void;
}

export function MobileProfile({ user, onLogout, onWebView }: ProfileProps) {
  const [language, setLanguage] = useState(() => {
    try {
      return localStorage.getItem('saathi.language') ?? '';
    } catch {
      return '';
    }
  });
  const [alerts, setAlerts] = useState<boolean | null>(null);
  useEffect(() => {
    api
      .alerts()
      .then((result) => setAlerts(result.enabled))
      .catch(() => setAlerts(null));
  }, []);

  return (
    <div className="m-page">
      <div className="m-profile-hero">
        <span className="m-avatar large light">{initials(user.display_name)}</span>
        <strong>{user.display_name.replace(' (demo)', '')}</strong>
        <small>{user.user_id}</small>
      </div>
      <div className="m-page-body">
        <ul className="m-settings">
          <li>
            <Icon name="globe" />
            <span>Language</span>
            <select
              value={language}
              onChange={(event) => {
                setLanguage(event.target.value);
                try {
                  localStorage.setItem('saathi.language', event.target.value);
                } catch {
                  // convenience only
                }
              }}
            >
              {LANGUAGES.map((item) => (
                <option key={item.code} value={item.code}>
                  {item.code ? item.label : 'Auto'}
                </option>
              ))}
            </select>
          </li>
          <li>
            <Icon name="bell" />
            <span>Smart alerts</span>
            <button
              className={`m-switch ${alerts ? 'on' : ''}`}
              role="switch"
              aria-checked={Boolean(alerts)}
              disabled={alerts === null}
              onClick={async () => setAlerts((await api.setAlerts(!alerts)).enabled)}
            >
              <span />
            </button>
          </li>
          <li>
            <Icon name="monitor" />
            <span>Switch to web view</span>
            <button className="m-link" onClick={onWebView}>
              Open
            </button>
          </li>
          <li>
            <Icon name="lock" />
            <span>Privacy</span>
            <small className="m-muted">Consent per case</small>
          </li>
        </ul>
        <p className="m-fineprint">Synthetic demo data. Claims, loans and refunds are simulated; partners make the real decisions.</p>
        <button className="m-btn ghost danger" onClick={onLogout}>
          <Icon name="logout" size={18} /> Sign out
        </button>
      </div>
    </div>
  );
}
