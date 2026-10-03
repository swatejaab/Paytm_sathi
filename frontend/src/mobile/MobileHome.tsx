import { useEffect, useState } from 'react';
import { api } from '../api';
import { inr } from '../format';
import type { CashForecast, FinancialTwin, ProactiveAlert, SessionUser } from '../types';
import { Icon, type IconName } from './Icon';
import { initials } from './MobileLogin';

export const JOURNEYS = {
  hospital: 'Papa hospital mein hain. Bill INR 80,000 hai. Insurance hai, ab kya karun?',
  fraud: 'Mere account se INR 8,500 ka UPI payment hua jo maine nahi kiya. Kya karun?',
  refund: 'INR 2,450 ka UPI payment failed ho gaya, paise kat gaye par refund nahi aaya.',
  emi: 'Salary delayed hai, is mahine EMI bharne ke paise kam hain. Kya options hain?',
  expert: 'Mujhe apne paison ke baare mein ek specialist se baat karni hai.',
};

interface Props {
  user: SessionUser;
  onAsk: (message?: string) => void;
  onOpen: (tab: 'insights' | 'activity', section?: 'forecast' | 'afford' | 'credit') => void;
}

const UPCOMING_ICON: Record<string, IconName> = {
  emi: 'calendar',
  credit_card: 'wallet',
  salary: 'wallet',
  insurance: 'shield',
  sip: 'trend',
};

const when = (days: number, date: string) =>
  days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days < 7 ? `In ${days} days` : new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export function MobileHome({ user, onAsk, onOpen }: Props) {
  const [twin, setTwin] = useState<FinancialTwin | null>(null);
  const [forecast, setForecast] = useState<CashForecast | null>(null);
  const [alerts, setAlerts] = useState<{ enabled: boolean; alerts: ProactiveAlert[] } | null>(null);
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    api.twin().then(setTwin).catch(() => undefined);
    api.forecast().then(setForecast).catch(() => undefined);
    api.alerts().then(setAlerts).catch(() => undefined);
  }, []);

  const money = (amount: number) => (hidden ? '₹ ••••' : inr(amount));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const alertCount = alerts?.alerts.length ?? 0;

  const services: { icon: IconName; label: string; tone: string; action: () => void }[] = [
    { icon: 'hospital', label: 'Hospital bill', tone: 'blue', action: () => onAsk(JOURNEYS.hospital) },
    { icon: 'shield', label: 'Unknown payment', tone: 'red', action: () => onAsk(JOURNEYS.fraud) },
    { icon: 'refund', label: 'Refund stuck', tone: 'amber', action: () => onAsk(JOURNEYS.refund) },
    { icon: 'calendar', label: 'EMI help', tone: 'violet', action: () => onAsk(JOURNEYS.emi) },
    { icon: 'scale', label: 'Can I afford?', tone: 'green', action: () => onOpen('insights', 'afford') },
    { icon: 'trend', label: 'Cash forecast', tone: 'cyan', action: () => onOpen('insights', 'forecast') },
    { icon: 'gauge', label: 'Credit score', tone: 'slate', action: () => onOpen('insights', 'credit') },
    { icon: 'headset', label: 'Talk to expert', tone: 'pink', action: () => onAsk(JOURNEYS.expert) },
  ];

  return (
    <div className="m-home">
      <header className="m-hero">
        <div className="m-hero-top">
          <span className="m-avatar light">{initials(user.display_name)}</span>
          <div className="m-hero-greet">
            <small>{greeting}</small>
            <strong>{user.display_name.replace(' (demo)', '').split(' ')[0]}</strong>
          </div>
          <button className="m-icon-btn" onClick={() => document.getElementById('m-alerts')?.scrollIntoView({ behavior: 'smooth' })} aria-label={`${alertCount} alerts`}>
            <Icon name="bell" />
            {alertCount > 0 && <span className="m-badge">{alertCount}</span>}
          </button>
        </div>

        <div className="m-balance">
          <div className="m-balance-row">
            <small>Bank balance</small>
            <button className="m-eye" onClick={() => setHidden((value) => !value)} aria-label={hidden ? 'Show amounts' : 'Hide amounts'}>
              <Icon name={hidden ? 'eyeOff' : 'eye'} size={18} />
            </button>
          </div>
          <strong className="m-balance-amount">{twin ? money(twin.assets[0]?.value_inr ?? 0) : '—'}</strong>
          <div className="m-balance-stats">
            <div>
              <small>Safe to spend</small>
              <b>{forecast ? money(forecast.safe_to_spend_inr) : '—'}</b>
            </div>
            <div>
              <small>Savings</small>
              <b>{twin ? money(twin.emergency.savings_inr) : '—'}</b>
            </div>
            <div>
              <small>Net worth</small>
              <b className={twin && twin.net_position.net_inr < 0 ? 'neg' : ''}>{twin ? money(twin.net_position.net_inr) : '—'}</b>
            </div>
          </div>
        </div>
      </header>

      <div className="m-content">
        {forecast && forecast.crunch_inr > 0 && (
          <button className="m-attention" onClick={() => onOpen('insights', 'forecast')}>
            <span className="m-attention-icon">
              <Icon name="alert" />
            </span>
            <span className="m-attention-text">
              <strong>{inr(forecast.crunch_inr)} short before payday</strong>
              <small>Lowest on {new Date(`${forecast.lowest.date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}. Tap to fix</small>
            </span>
            <Icon name="next" size={18} />
          </button>
        )}

        <button className="m-ask" onClick={() => onAsk()}>
          <span className="m-ask-icon">
            <Icon name="sparkle" />
          </span>
          <span>
            <strong>Ask Saathi</strong>
            <small>Speak or type, any language</small>
          </span>
          <span className="m-ask-mic">
            <Icon name="mic" size={20} />
          </span>
        </button>

        <section className="m-section">
          <h3>Saathi services</h3>
          <div className="m-services">
            {services.map((service) => (
              <button key={service.label} className="m-service" onClick={service.action}>
                <span className={`m-service-icon tone-${service.tone}`}>
                  <Icon name={service.icon} />
                </span>
                <span>{service.label}</span>
              </button>
            ))}
          </div>
        </section>

        {twin && (
          <section className="m-section">
            <div className="m-section-head">
              <h3>Upcoming</h3>
              <button className="m-link" onClick={() => onOpen('insights', 'forecast')}>
                See all
              </button>
            </div>
            <ul className="m-list">
              {twin.obligations.slice(0, 4).map((item) => (
                <li key={`${item.title}-${item.due_date}`}>
                  <span className={`m-list-icon ${item.direction}`}>
                    <Icon name={UPCOMING_ICON[item.kind] ?? 'calendar'} size={18} />
                  </span>
                  <span className="m-list-text">
                    <strong>{item.title}</strong>
                    <small>{when(item.days_away, item.due_date)}</small>
                  </span>
                  <b className={item.direction === 'in' ? 'pos' : ''}>
                    {item.direction === 'in' ? '+' : '−'}
                    {hidden ? '••••' : inr(item.amount_inr).replace('₹', '₹')}
                  </b>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="m-section" id="m-alerts">
          <div className="m-section-head">
            <h3>Saathi noticed</h3>
            {alerts && !alerts.enabled && (
              <button className="m-link" onClick={async () => setAlerts(await api.setAlerts(true))}>
                Turn on
              </button>
            )}
          </div>
          {alerts && !alerts.enabled && <p className="m-muted small">Get a heads-up before money trouble. Off by default.</p>}
          {alerts?.enabled && alertCount === 0 && <p className="m-muted small">All clear. We'll tell you if something needs you.</p>}
          {alerts?.alerts.map((alert) => (
            <div key={alert.alert_id} className={`m-alert ${alert.severity}`}>
              <div>
                <strong>{alert.title}</strong>
                <div className="m-alert-actions">
                  <button className="m-chip-btn primary" onClick={() => onAsk(alert.suggested_message)}>
                    Get help
                  </button>
                  <button className="m-chip-btn" onClick={async () => setAlerts(await api.dismissAlert(alert.alert_id))}>
                    Dismiss
                  </button>
                </div>
              </div>
            </div>
          ))}
        </section>

        {twin && twin.goals.length > 0 && (
          <section className="m-section">
            <h3>Goals</h3>
            {twin.goals.map((goal) => (
              <div key={goal.goal} className="m-goal">
                <div className="m-goal-row">
                  <strong>{goal.goal.replace(/\s*\(.*\)/, '')}</strong>
                  <small>{goal.progress_pct}%</small>
                </div>
                <div className="m-progress">
                  <span style={{ width: `${Math.max(goal.progress_pct, 3)}%` }} />
                </div>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  );
}
