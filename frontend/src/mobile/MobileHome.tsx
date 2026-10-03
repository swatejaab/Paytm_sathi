import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { inr } from '../format';
import type { CashForecast, FinancialTwin, ProactiveAlert, SessionUser } from '../types';
import { Icon, type IconName } from './Icon';
import { initials } from './MobileLogin';

// Each service opens a fresh Saathi chat with a topic prompt; the customer describes their own situation.
export const TOPICS = {
  hospital: 'Who is admitted, and how much is the hospital bill?',
  fraud: "Which payment don't you recognise? Share the amount.",
  refund: 'Which payment failed, and for how much?',
  emi: 'Which EMI is due, and how much are you short?',
  term: 'Tell me about the cover you want, e.g. term life for your family.',
  expert: 'What would you like a specialist to help with?',
  ask: 'Ask anything about your money…',
};

type Section = 'forecast' | 'afford' | 'credit';

interface Props {
  user: SessionUser;
  onTopic: (hint: string) => void;
  onOpen: (tab: 'insights' | 'activity', section?: Section) => void;
}

const UPCOMING_ICON: Record<string, IconName> = {
  emi: 'calendar',
  credit_card: 'wallet',
  salary: 'wallet',
  insurance: 'shield',
  sip: 'trend',
  bill: 'bill',
};

const when = (days: number, date: string) =>
  days === 0 ? 'Today' : days === 1 ? 'Tomorrow' : days < 7 ? `In ${days} days` : new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export function MobileHome({ user, onTopic, onOpen }: Props) {
  const [twin, setTwin] = useState<FinancialTwin | null>(null);
  const [forecast, setForecast] = useState<CashForecast | null>(null);
  const [alerts, setAlerts] = useState<{ enabled: boolean; alerts: ProactiveAlert[] } | null>(null);
  const [hidden, setHidden] = useState(false);
  const [goalForm, setGoalForm] = useState(false);

  const loadTwin = () => api.twin().then(setTwin).catch(() => undefined);
  useEffect(() => {
    void loadTwin();
    api.forecast().then(setForecast).catch(() => undefined);
    api.alerts().then(setAlerts).catch(() => undefined);
  }, []);

  const money = (amount: number) => (hidden ? '₹ ••••' : inr(amount));
  const hour = new Date().getHours();
  const greeting = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
  const alertCount = alerts?.alerts.length ?? 0;

  const quick: { icon: IconName; label: string; action: () => void }[] = [
    { icon: 'mic', label: 'Ask Saathi', action: () => onTopic(TOPICS.ask) },
    { icon: 'trend', label: 'Cash flow', action: () => onOpen('insights', 'forecast') },
    { icon: 'gauge', label: 'Credit score', action: () => onOpen('insights', 'credit') },
    { icon: 'folder', label: 'My cases', action: () => onOpen('activity') },
  ];

  const groups: { title: string; items: { icon: IconName; label: string; tone: string; action: () => void }[] }[] = [
    {
      title: 'Solve a money problem',
      items: [
        { icon: 'hospital', label: 'Hospital bill', tone: 'blue', action: () => onTopic(TOPICS.hospital) },
        { icon: 'shield', label: 'Unknown payment', tone: 'red', action: () => onTopic(TOPICS.fraud) },
        { icon: 'refund', label: 'Refund stuck', tone: 'amber', action: () => onTopic(TOPICS.refund) },
        { icon: 'calendar', label: 'EMI help', tone: 'violet', action: () => onTopic(TOPICS.emi) },
      ],
    },
    {
      title: 'Plan and protect',
      items: [
        { icon: 'umbrella', label: 'Term insurance', tone: 'green', action: () => onTopic(TOPICS.term) },
        { icon: 'scale', label: 'Can I afford?', tone: 'cyan', action: () => onOpen('insights', 'afford') },
        { icon: 'gauge', label: 'Credit score', tone: 'slate', action: () => onOpen('insights', 'credit') },
        { icon: 'headset', label: 'Talk to expert', tone: 'pink', action: () => onTopic(TOPICS.expert) },
      ],
    },
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
        <section className="m-quick">
          {quick.map((item) => (
            <button key={item.label} onClick={item.action}>
              <span className="m-quick-icon">
                <Icon name={item.icon} />
              </span>
              <span>{item.label}</span>
            </button>
          ))}
        </section>

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

        {groups.map((group) => (
          <section key={group.title} className="m-section">
            <h3>{group.title}</h3>
            <div className="m-services">
              {group.items.map((service) => (
                <button key={service.label} className="m-service" onClick={service.action}>
                  <span className={`m-service-icon tone-${service.tone}`}>
                    <Icon name={service.icon} />
                  </span>
                  <span>{service.label}</span>
                </button>
              ))}
            </div>
          </section>
        ))}

        {twin && (
          <section className="m-section">
            <div className="m-section-head">
              <h3>Upcoming payments</h3>
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
                    {hidden ? '••••' : inr(item.amount_inr)}
                  </b>
                </li>
              ))}
            </ul>
          </section>
        )}

        {alerts && (alerts.alerts.length > 0 || !alerts.enabled) && (
          <section className="m-section" id="m-alerts">
            <div className="m-section-head">
              <h3>Saathi noticed</h3>
              {!alerts.enabled && (
                <button className="m-link" onClick={async () => setAlerts(await api.setAlerts(true))}>
                  Turn on
                </button>
              )}
            </div>
            {!alerts.enabled && <p className="m-muted small">Get a heads-up before money trouble.</p>}
            {alerts.alerts.map((alert) => (
              <div key={alert.alert_id} className={`m-alert ${alert.severity}`}>
                <strong>{alert.title}</strong>
                <div className="m-alert-actions">
                  <button className="m-chip-btn primary" onClick={() => onTopic(`${alert.title}. Tell Saathi what you need.`)}>
                    Get help
                  </button>
                  <button className="m-chip-btn" onClick={async () => setAlerts(await api.dismissAlert(alert.alert_id))}>
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </section>
        )}

        {twin && (
          <section className="m-section">
            <div className="m-section-head">
              <h3>Goals</h3>
              <button className="m-link" onClick={() => setGoalForm(true)}>
                + Add goal
              </button>
            </div>
            {twin.goals.map((goal) => (
              <div key={`${goal.goal}-${goal.id ?? ''}`} className="m-goal">
                <div className="m-goal-row">
                  <strong>{goal.goal.replace(/\s*\(.*\)/, '')}</strong>
                  <span className="m-goal-side">
                    <small>{goal.progress_pct}%</small>
                    {goal.id && (
                      <button className="m-goal-delete" onClick={async () => { await api.deleteGoal(goal.id!); void loadTwin(); }} aria-label={`Delete ${goal.goal}`}>
                        <Icon name="trash" size={15} />
                      </button>
                    )}
                  </span>
                </div>
                <div className="m-progress">
                  <span style={{ width: `${Math.max(goal.progress_pct, 3)}%` }} />
                </div>
                <small className="m-muted">{inr(goal.saved_inr)} of {inr(goal.target_inr)} · {inr(goal.monthly_needed_inr)}/month</small>
              </div>
            ))}
          </section>
        )}
      </div>

      {goalForm && <GoalSheet onClose={() => setGoalForm(false)} onSaved={() => { setGoalForm(false); void loadTwin(); }} />}
    </div>
  );
}

export function GoalSheet({ onClose, onSaved, fixed = false }: { onClose: () => void; onSaved: () => void; fixed?: boolean }) {
  const [name, setName] = useState('');
  const [target, setTarget] = useState('');
  const [saved, setSaved] = useState('');
  const [date, setDate] = useState(() => new Date(Date.now() + 365 * 86_400_000).toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const amount = (value: string) => Number(value.replace(/[^0-9]/g, ''));

  const save = async () => {
    setError(null);
    try {
      await api.addGoal({ goal: name.trim(), target_inr: amount(target), target_date: date, saved_inr: amount(saved) || 0 });
      onSaved();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not save the goal.');
    }
  };

  return (
    <div className={`m-sheet-backdrop ${fixed ? 'fixed' : ''}`} onClick={onClose}>
      <div className="m-sheet m-form" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
        <span className="m-sheet-handle" />
        <h3>New goal</h3>
        <label>
          Goal name
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="e.g. Child's education" maxLength={60} />
        </label>
        <label>
          Target amount (₹)
          <input value={target} onChange={(event) => setTarget(event.target.value)} inputMode="numeric" placeholder="500000" />
        </label>
        <label>
          Already saved (₹)
          <input value={saved} onChange={(event) => setSaved(event.target.value)} inputMode="numeric" placeholder="0" />
        </label>
        <label>
          Target date
          <input type="date" value={date} onChange={(event) => setDate(event.target.value)} />
        </label>
        {error && <p className="m-error">{error}</p>}
        <button className="m-btn primary" disabled={name.trim().length < 2 || !amount(target)} onClick={() => void save()}>
          Save goal
        </button>
        <button className="m-btn ghost" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
