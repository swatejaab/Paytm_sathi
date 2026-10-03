import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { inr } from '../format';
import type { FinancialTwin } from '../types';
import { AlertsPanel } from './AlertsPanel';

interface Props {
  displayName: string;
  onAsk: (message: string) => void;
}

const MODES: { mode: string; hint: string; message: string }[] = [
  { mode: 'RECOVER', hint: 'Hospital bill', message: 'Papa hospital mein hain. Bill INR 80,000 hai. Insurance hai, ab kya karun?' },
  { mode: 'PROTECT', hint: 'Payment I did not make', message: 'Mere account se INR 8,500 ka UPI payment hua jo maine nahi kiya. Kya karun?' },
  { mode: 'RECOVER', hint: 'Failed payment refund', message: 'INR 2,450 ka UPI payment failed ho gaya, paise kat gaye par refund nahi aaya.' },
  { mode: 'PLAN', hint: 'EMI before payday', message: 'Salary delayed hai, is mahine EMI bharne ke paise kam hain. Kya options hain?' },
];

const KIND_ICON: Record<string, string> = {
  rent: '🏠',
  education: '🎓',
  bill: '💡',
  sip: '📈',
  insurance: '🛡️',
  emi: '🏍️',
  credit_card: '💳',
  salary: '💰',
};

function greeting(): string {
  const hour = new Date().getHours();
  return hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
}

function whenLabel(days: number, date: string): string {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 7) return `In ${days} days`;
  return new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export function HomeView({ displayName, onAsk }: Props) {
  const [twin, setTwin] = useState<FinancialTwin | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    api
      .twin()
      .then(setTwin)
      .catch((caught) => setError(caught instanceof ApiError ? caught.message : 'Could not load your financial picture.'));
  }, []);

  if (error) return <main className="home"><p className="alert alert-error">{error}</p></main>;
  if (!twin) return <main className="home"><p className="muted">Loading your financial picture...</p></main>;

  let running = twin.before_salary.balance_inr;
  const upcoming = twin.obligations.map((item) => {
    running += item.direction === 'in' ? item.amount_inr : -item.amount_inr;
    return { ...item, balance_after: running };
  });
  const health = twin.insurance.find((policy) => policy.kind === 'health');
  const tiles = [
    { label: 'Cash', value: twin.assets[0]?.value_inr ?? 0, note: 'Bank and wallet' },
    { label: 'Emergency fund', value: twin.emergency.savings_inr, note: `${twin.emergency.months_covered} months of expenses` },
    {
      label: 'Investments',
      value: twin.assets.slice(2).reduce((sum, line) => sum + line.value_inr, 0),
      note: `${twin.assets.length - 2} holding(s)`,
    },
    {
      label: 'Loans and cards',
      value: twin.net_position.liabilities_inr,
      note: `EMIs ${Math.round(twin.cash_flow.emi_to_income * 100)}% of income`,
      negative: true,
    },
    { label: 'Health cover', value: health?.cover_inr ?? 0, note: health ? `Renews in ${health.days_to_renewal} days` : 'No policy on file' },
  ];

  return (
    <main className="home">
      <section className={`home-hero card status-${twin.summary.status}`}>
        <div>
          <p className="eyebrow">
            {greeting()}, {displayName.split(' ')[0]}
          </p>
          <h1>{twin.summary.headline}</h1>
          <p className="muted small">Your Saathi Financial Twin, as of {twin.as_of}. Every number below links to its source.</p>
        </div>
        <div className="net-position">
          <small>Net financial position</small>
          <strong className={twin.net_position.net_inr < 0 ? 'neg' : ''}>{inr(twin.net_position.net_inr)}</strong>
          <small className="muted">
            {inr(twin.net_position.assets_inr)} assets − {inr(twin.net_position.liabilities_inr)} liabilities
          </small>
        </div>
      </section>

      <section className="ask-bar card">
        <p className="eyebrow">Ask Saathi</p>
        <h2>What do you want to do with your money?</h2>
        <div className="composer">
          <textarea
            rows={2}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="Tell Saathi what happened, in any language. You can also speak or upload a bill in the Saathi tab."
          />
          <button className="btn btn-primary" disabled={draft.trim().length < 8} onClick={() => onAsk(draft.trim())}>
            Ask
          </button>
        </div>
        <div className="mode-chips">
          {MODES.map((item) => (
            <button key={item.mode} className="mode-chip" onClick={() => onAsk(item.message)}>
              <strong>{item.mode}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </div>
      </section>

      <div className="home-grid">
        <section className="card home-section">
          <h3>Needs attention</h3>
          {twin.before_salary.shortfall_inr > 0 && (
            <div className="alert-card alert-card-high">
              <div>
                <p className="eyebrow">Before payday</p>
                <strong>
                  You may be {inr(twin.before_salary.shortfall_inr)} short before your salary on {twin.before_salary.salary_date}
                </strong>
                <p className="muted small">
                  {inr(twin.before_salary.due_inr)} of bills fall due first; your balance is {inr(twin.before_salary.balance_inr)}.
                </p>
              </div>
              <div className="alert-card-actions">
                <button className="btn btn-primary" onClick={() => onAsk(MODES.find((item) => item.mode === 'PLAN')!.message)}>
                  See my options
                </button>
              </div>
            </div>
          )}
          {twin.renewals_due.map((policy) => (
            <div key={policy} className="alert-card">
              <div>
                <p className="eyebrow">Renewal</p>
                <strong>{policy} renews within 30 days</strong>
              </div>
            </div>
          ))}
          <AlertsPanel busy={false} onStart={onAsk} refreshKey="home" />
        </section>

        <section className="card home-section">
          <h3>Upcoming: your financial inbox</h3>
          <p className="muted small">Next 30 days, with your projected balance after each item.</p>
          <ul className="inbox">
            {upcoming.map((item, index) => (
              <li key={`${item.title}-${index}`} className={`inbox-item ${item.direction}`}>
                <span className="inbox-icon" aria-hidden>
                  {KIND_ICON[item.kind] ?? '•'}
                </span>
                <span className="inbox-main">
                  <strong>{item.title}</strong>
                  <small className="muted">
                    {whenLabel(item.days_away, item.due_date)} / {item.source}
                  </small>
                </span>
                <span className="inbox-amount">
                  <strong>
                    {item.direction === 'in' ? '+' : '−'}
                    {inr(item.amount_inr)}
                  </strong>
                  <small className={item.balance_after < 0 ? 'neg' : 'muted'}>bal {inr(item.balance_after)}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>

      <section className="card home-section">
        <h3>Your money</h3>
        <div className="money-tiles">
          {tiles.map((tile) => (
            <div key={tile.label} className="money-tile">
              <small>{tile.label}</small>
              <strong className={tile.negative ? 'neg' : ''}>{inr(tile.value)}</strong>
              <small className="muted">{tile.note}</small>
            </div>
          ))}
        </div>
      </section>

      <div className="home-grid">
        <section className="card home-section">
          <h3>Goals</h3>
          {twin.goals.map((goal) => (
            <div key={goal.goal} className="goal">
              <div className="row space-between">
                <strong>{goal.goal}</strong>
                <small className="muted">
                  {inr(goal.saved_inr)} of {inr(goal.target_inr)}
                </small>
              </div>
              <div className="progress" aria-label={`${goal.progress_pct}% saved`}>
                <span style={{ width: `${goal.progress_pct}%` }} />
              </div>
              <small className="muted">
                {goal.progress_pct}% saved / needs {inr(goal.monthly_needed_inr)} a month for {goal.months_left} months
              </small>
            </div>
          ))}
        </section>

        <section className="card home-section">
          <h3>This month's cash flow</h3>
          <dl className="cash-flow">
            <dt>Income</dt>
            <dd>{inr(twin.cash_flow.income_inr)}</dd>
            <dt>Essential spending</dt>
            <dd>−{inr(twin.cash_flow.essentials_inr)}</dd>
            <dt>EMIs</dt>
            <dd>−{inr(twin.cash_flow.emi_inr)}</dd>
            <dt>
              <strong>Free cash</strong>
            </dt>
            <dd>
              <strong>{inr(twin.cash_flow.free_cash_inr)}</strong>
            </dd>
          </dl>
          <p className="muted small">Source: {twin.cash_flow.source}. {twin.notice}</p>
        </section>
      </div>
    </main>
  );
}
