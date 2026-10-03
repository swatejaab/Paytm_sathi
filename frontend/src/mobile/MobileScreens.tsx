import { useEffect, useState } from 'react';
import { api } from '../api';
import { AffordCard } from '../components/AffordCard';
import { CreditScoreCard } from '../components/CreditScoreCard';
import { ForecastCard } from '../components/ForecastCard';
import { EVENT_LABELS, LANGUAGES, STATUS_LABELS } from '../format';
import type { Theme } from '../theme';
import type { CaseSummary, EventType, SessionUser, StandingConsents } from '../types';
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
  protection: 'shield',
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
  theme: Theme;
  onToggleTheme: () => void;
}

export function MobileProfile({ user, onLogout, onWebView, theme, onToggleTheme }: ProfileProps) {
  const [consents, setConsents] = useState<StandingConsents | null>(null);
  useEffect(() => {
    api.consents().then(setConsents).catch(() => setConsents(null));
  }, []);
  const toggleConsent = async (key: keyof StandingConsents) => {
    if (!consents) return;
    setConsents(await api.setConsents({ [key]: !consents[key] }));
  };
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
            <Icon name={theme === 'dark' ? 'moon' : 'sun'} />
            <span>Dark theme</span>
            <button className={`m-switch ${theme === 'dark' ? 'on' : ''}`} role="switch" aria-checked={theme === 'dark'} onClick={onToggleTheme}>
              <span />
            </button>
          </li>
          {([['records', 'Read my records'], ['ai', 'AI answers'], ['voice', 'Voice input']] as const).map(([key, label]) => (
            <li key={key}>
              <Icon name={key === 'voice' ? 'mic' : key === 'ai' ? 'sparkle' : 'lock'} />
              <span>
                {label}
                <small className="m-setting-note">{consents?.[key] ? 'Allowed, no need to ask' : 'Ask me each time'}</small>
              </span>
              <button className={`m-switch ${consents?.[key] ? 'on' : ''}`} role="switch" aria-checked={Boolean(consents?.[key])} disabled={!consents} onClick={() => void toggleConsent(key)}>
                <span />
              </button>
            </li>
          ))}
          <li>
            <Icon name="monitor" />
            <span>Switch to web view</span>
            <button className="m-link" onClick={onWebView}>
              Open
            </button>
          </li>
        </ul>
        <button className="m-btn ghost danger" onClick={onLogout}>
          <Icon name="logout" size={18} /> Sign out
        </button>
      </div>
    </div>
  );
}
