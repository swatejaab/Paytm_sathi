import { api } from '../api';
import { Icon } from '../components/Icon';
import { InsightList } from '../components/InsightList';
import { SosStrip, TAGLINE } from '../components/MoneySos';
import { ErrorState, Skeleton, useAsync } from '../components/ui';
import { inr, relativeTime } from '../format';
import { navigate, routeHref } from '../router';
import { CTAS } from './Landing';

export function Home({ name, onAsk }: { name: string; onAsk: (text: string) => void }) {
  const insights = useAsync(() => api.insights());
  const recent = useAsync(() => api.listCases());
  const firstName = name.split(' ')[0];
  const kpis = insights.data?.kpis;
  const goals = insights.data?.goals.filter((goal) => goal.status !== 'completed').slice(0, 3) ?? [];
  const chats = recent.data?.cases.slice(0, 4) ?? [];

  return (
    <main className="page home">
      <section className="hero hero-compact">
        <div className="hero-copy">
          <p className="eyebrow">Hi {firstName}</p>
          <h1>
            Meet <span className="accent">Paytm Saathi</span>
          </h1>
          <p className="lead tagline">{TAGLINE}</p>
          <p className="lead">Your AI companion for everyday financial decisions and emergencies.</p>
          <SosStrip />
          <div className="cta-row">
            {CTAS.map((cta) => (
              <button key={cta.label} className={`btn ${cta.primary ? 'btn-primary' : 'btn-outline'}`} onClick={() => navigate(cta.page)}>
                <Icon name={cta.icon} size={18} /> {cta.label}
              </button>
            ))}
          </div>
        </div>
      </section>

      <div className="home-grid">
        <section className="card">
          <header className="section-head">
            <h2>For you</h2>
            <a className="link" href={routeHref('insights')}>
              See insights
            </a>
          </header>
          {insights.loading && !insights.data ? (
            <Skeleton lines={4} />
          ) : insights.error ? (
            <ErrorState message={insights.error} onRetry={insights.reload} />
          ) : (
            <InsightList items={insights.data!.insights.slice(0, 4)} onAsk={onAsk} />
          )}
        </section>

        <section className="card">
          <header className="section-head">
            <h2>This month</h2>
            {insights.data && <small className="muted">{insights.data.period.label}</small>}
          </header>
          {kpis ? (
            <div className="mini-kpis">
              <a href={routeHref('insights')} className="mini-kpi">
                <small>Income</small>
                <strong>{inr(kpis.income_inr)}</strong>
              </a>
              <a href={routeHref('insights')} className="mini-kpi">
                <small>Spending</small>
                <strong>{inr(kpis.spending_inr)}</strong>
              </a>
              <a href={routeHref('insights')} className="mini-kpi">
                <small>Saved</small>
                <strong>{inr(kpis.savings_inr)}</strong>
              </a>
              <a href={routeHref('insights')} className="mini-kpi">
                <small>Financial health</small>
                <strong>
                  {kpis.health.score}
                  <span className="muted small"> / 100 · {kpis.health.band}</span>
                </strong>
              </a>
            </div>
          ) : insights.error ? null : (
            <Skeleton lines={2} />
          )}

          <header className="section-head spaced">
            <h2>Goals</h2>
            <a className="link" href={routeHref('goals')}>
              {goals.length ? 'All goals' : 'Add a goal'}
            </a>
          </header>
          {goals.length === 0 ? (
            <p className="muted small">Set a savings goal and Saathi will factor it into every money decision.</p>
          ) : (
            <div className="goal-mini-list">
              {goals.map((goal) => (
                <a key={goal.goal_id} href={routeHref('goals')} className="goal-mini">
                  <div className="row space-between">
                    <strong>{goal.name}</strong>
                    <small className="muted">
                      {inr(goal.saved_inr)} of {inr(goal.target_inr)}
                    </small>
                  </div>
                  <div className="progress-track">
                    <span style={{ width: `${Math.min(goal.progress_pct, 100)}%` }} />
                  </div>
                </a>
              ))}
            </div>
          )}
        </section>

        <section className="card">
          <header className="section-head">
            <h2>Recent chats</h2>
            <button className="link" onClick={() => navigate('saathi', 'new')}>
              New chat
            </button>
          </header>
          {recent.error ? (
            <ErrorState message={recent.error} onRetry={recent.reload} />
          ) : chats.length === 0 ? (
            <p className="muted small">{recent.loading ? 'Loading...' : 'Your conversations with Saathi will appear here.'}</p>
          ) : (
            <ul className="recent-list">
              {chats.map((chat) => (
                <li key={chat.case_id}>
                  <a href={routeHref('saathi', chat.case_id)}>
                    <Icon name="chat" size={18} />
                    <span>
                      <strong>{chat.title}</strong>
                      <small className="muted">{relativeTime(chat.updated_at)}</small>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
