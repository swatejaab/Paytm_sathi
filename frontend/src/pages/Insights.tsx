import { useEffect, useState } from 'react';
import { api } from '../api';
import { AffordCard } from '../components/AffordCard';
import { AssetsCard } from '../components/AssetsCard';
import { BarList, CHART_COLORS, ColumnChart, DonutChart, LineChart } from '../components/charts';
import { CreditScoreCard } from '../components/CreditScoreCard';
import { ForecastCard } from '../components/ForecastCard';
import { InsightList } from '../components/InsightList';
import { EmptyState, ErrorState, Kpi, Panel, Skeleton, useAsync } from '../components/ui';
import { inr, shortDate } from '../format';
import { navigate, routeHref } from '../router';

type Tab = 'overview' | 'assets' | 'forecast' | 'credit' | 'afford';
const TABS: { id: Tab; label: string }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'assets', label: 'Assets & net worth' },
  { id: 'forecast', label: 'Cash flow forecast' },
  { id: 'credit', label: 'Credit health' },
  { id: 'afford', label: 'Can I afford it?' },
];

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1).replace(/_/g, ' ');

const isTab = (value: string | null): value is Tab => TABS.some((item) => item.id === value);

export function Insights({ onAsk, tab: routeTab }: { onAsk: (text: string) => void; tab: string | null }) {
  const [tab, setTabState] = useState<Tab>(isTab(routeTab) ? routeTab : 'overview');
  useEffect(() => {
    if (isTab(routeTab)) setTabState(routeTab);
  }, [routeTab]);
  const setTab = (next: Tab) => {
    setTabState(next);
    navigate('insights', next === 'overview' ? null : next, { replace: true });
  };
  const { data, error, loading, reload } = useAsync(() => api.insights());

  return (
    <main className="page insights">
      <header className="page-head">
        <div>
          <h1>Insights</h1>
          <p className="muted">{data ? `Your money in ${data.period.label}, from your account statements.` : 'Your money at a glance.'}</p>
        </div>
      </header>

      <nav className="segmented" role="tablist" aria-label="Insights views">
        {TABS.map((item) => (
          <button key={item.id} role="tab" aria-selected={tab === item.id} className={tab === item.id ? 'active' : ''} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>

      {tab === 'assets' && <AssetsCard onAsk={onAsk} />}
      {tab === 'forecast' && <ForecastCard onAsk={onAsk} />}
      {tab === 'credit' && <CreditScoreCard />}
      {tab === 'afford' && <AffordCard />}

      {tab === 'overview' &&
        (loading && !data ? (
          <div className="kpi-grid">
            {Array.from({ length: 6 }, (_, index) => (
              <div key={index} className="kpi">
                <Skeleton lines={2} />
              </div>
            ))}
          </div>
        ) : error ? (
          <ErrorState message={error} onRetry={reload} />
        ) : !data ? (
          <EmptyState icon="insights" title="No statements yet" body="Insights appear once your account statements are available." />
        ) : (
          <>
            <div className="kpi-grid">
              <Kpi icon="rupee" label="Income" value={inr(data.kpis.income_inr)} note={data.period.label} />
              <Kpi icon="card" label="Spending" value={inr(data.kpis.spending_inr)} note={`${Math.round((data.kpis.spending_inr / Math.max(data.kpis.income_inr, 1)) * 100)}% of income`} />
              <Kpi
                icon="wallet"
                label="Savings"
                value={inr(data.kpis.savings_inr)}
                note={`${data.kpis.savings_rate_pct}% savings rate`}
                tone={data.kpis.savings_rate_pct >= 20 ? 'good' : data.kpis.savings_rate_pct < 10 ? 'warn' : undefined}
              />
              <Kpi
                icon="calendar"
                label="Upcoming obligations"
                value={inr(data.kpis.upcoming_obligations_inr)}
                note={`${data.kpis.upcoming_count} payment${data.kpis.upcoming_count === 1 ? '' : 's'} due soon`}
              />
              <Kpi icon="trend" label="Outstanding debt" value={inr(data.kpis.outstanding_debt_inr)} note={`${inr(data.kpis.monthly_emi_inr)} a month in EMIs`} />
              <Kpi
                icon="gauge"
                label="Financial health"
                value={
                  <>
                    {data.kpis.health.score}
                    <span className="kpi-unit">/100</span>
                  </>
                }
                note={data.kpis.health.band}
                tone={data.kpis.health.score >= 75 ? 'good' : data.kpis.health.score >= 50 ? 'warn' : 'alert'}
              />
            </div>

            <details className="card health-detail">
              <summary>How your financial health score is calculated</summary>
              <BarList
                rows={data.kpis.health.parts.map((part) => ({ label: part.label, value: part.score, secondary: `${part.score} of ${part.max} points` }))}
                format={(value) => `${value} pts`}
              />
            </details>

            <div className="charts-layout">
              <Panel title="Income vs Expenses" subtitle="Monthly">
                <ColumnChart
                  data={data.months.map((month) => ({ label: month.label, values: { income: month.income_inr, spending: month.spending_inr } }))}
                  series={[
                    { key: 'income', label: 'Income', color: CHART_COLORS[0]! },
                    { key: 'spending', label: 'Expenses', color: CHART_COLORS[1]! },
                  ]}
                />
              </Panel>
              <Panel title="Spending by Category" subtitle={data.period.label}>
                <DonutChart slices={data.categories.map((item) => ({ label: capitalize(item.category), value: item.amount_inr }))} centerLabel="Total spent" />
              </Panel>
              <Panel title="Cash Flow" subtitle="Net each month and running total">
                <LineChart
                  points={data.cash_flow.map((point) => ({ label: point.label, values: { cumulative: point.cumulative_inr, net: point.net_inr } }))}
                  series={[
                    { key: 'cumulative', label: 'Running total', color: CHART_COLORS[0]! },
                    { key: 'net', label: 'Net this month', color: CHART_COLORS[2]! },
                  ]}
                />
              </Panel>
              <Panel title="Debt / EMI" subtitle={`${inr(data.kpis.monthly_emi_inr)} a month`}>
                {data.debts.length ? (
                  <BarList
                    rows={data.debts.map((debt) => ({
                      label: debt.name,
                      value: debt.outstanding_inr,
                      secondary: debt.emi_inr ? `EMI ${inr(debt.emi_inr)} a month` : 'Credit card balance',
                    }))}
                  />
                ) : (
                  <p className="muted">No outstanding loans or card balances.</p>
                )}
              </Panel>
              <Panel title="Savings Progress" subtitle="Saved and invested each month">
                <ColumnChart
                  data={data.months.map((month) => ({ label: month.label, values: { saved: Math.max(month.net_inr, 0), invested: month.invested_inr } }))}
                  series={[
                    { key: 'saved', label: 'Saved', color: CHART_COLORS[2]! },
                    { key: 'invested', label: 'Invested', color: CHART_COLORS[3]! },
                  ]}
                  height={200}
                />
                {data.goals.length > 0 ? (
                  <BarList
                    rows={data.goals.map((goal) => ({
                      label: goal.name,
                      value: goal.progress_pct,
                      secondary: `${inr(goal.saved_inr)} of ${inr(goal.target_inr)}${goal.status === 'paused' ? ' · paused' : ''}`,
                    }))}
                    format={(value) => `${Math.round(value)}%`}
                  />
                ) : (
                  <p className="muted small">
                    <a className="link" href={routeHref('goals')}>
                      Add a goal
                    </a>{' '}
                    to track progress here.
                  </p>
                )}
              </Panel>
              <Panel title="Upcoming Obligations" subtitle="Next 30 days">
                {data.upcoming.length ? (
                  <ul className="obligations">
                    {data.upcoming.map((item) => (
                      <li key={`${item.title}-${item.due_date}`}>
                        <span className={`due-chip ${item.days_away <= 3 ? 'soon' : ''}`}>
                          <strong>{item.days_away === 0 ? 'Today' : item.days_away}</strong>
                          {item.days_away === 0 ? '' : <small>day{item.days_away === 1 ? '' : 's'}</small>}
                        </span>
                        <span>
                          <strong>{item.title}</strong>
                          <small className="muted">
                            {shortDate(item.due_date)} · {capitalize(item.kind)}
                          </small>
                        </span>
                        <strong>{inr(item.amount_inr)}</strong>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted">Nothing due in the next 30 days.</p>
                )}
              </Panel>
            </div>

            <section className="card">
              <header className="section-head">
                <h2>Saathi noticed</h2>
              </header>
              <InsightList items={data.insights} onAsk={onAsk} />
            </section>
            <p className="muted tiny">Figures come from your account statements and records as of {shortDate(data.as_of)}.</p>
          </>
        ))}
    </main>
  );
}
