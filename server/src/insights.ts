import { formatDay, formatInr } from './decision';
import { monthSpending, statementsFor } from './financialContext';
import { fixtures } from './fixtures';
import { listGoals } from './goals';
import { buildTwin } from './twin';

export interface ProactiveInsight {
  id: string;
  tone: 'good' | 'info' | 'warn' | 'alert';
  title: string;
  detail: string;
  ask?: string;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthName = (month: string) => MONTH_NAMES[Number(month.slice(5, 7)) - 1] ?? month;

// Deterministic 0-100 score from four ratios on the customer's own records. Each part is reported so the score is explainable.
function healthScore(input: { savingsRate: number; emiRatio: number; emergencyMonths: number; shortfall: number; dueBeforeSalary: number }) {
  const parts = [
    { label: 'Savings rate', score: Math.round(Math.min(Math.max(input.savingsRate, 0) / 0.2, 1) * 30), max: 30 },
    { label: 'EMI burden', score: Math.round(Math.max(0, 1 - input.emiRatio / 0.4) * 25), max: 25 },
    { label: 'Emergency fund', score: Math.round(Math.min(input.emergencyMonths / 6, 1) * 25), max: 25 },
    {
      label: 'Cash before salary',
      score: input.shortfall <= 0 ? 20 : Math.round(20 * (1 - Math.min(input.shortfall / Math.max(input.dueBeforeSalary, 1), 1))),
      max: 20,
    },
  ];
  const score = parts.reduce((sum, part) => sum + part.score, 0);
  return { score, band: score >= 75 ? 'Healthy' : score >= 50 ? 'Fair' : 'Needs attention', parts };
}

export function buildInsights(customerId: string) {
  const twin = buildTwin(customerId, { audit: false });
  const statement = statementsFor(customerId);
  if (!twin || !statement?.months.length) return null;
  const months = statement.months.map((month) => {
    const spending = monthSpending(month);
    return {
      month: month.month,
      label: monthName(month.month).slice(0, 3),
      income_inr: month.income_inr,
      spending_inr: spending,
      emi_inr: month.emi_inr,
      invested_inr: month.invested_inr,
      net_inr: month.income_inr - spending,
    };
  });
  let running = 0;
  const cashFlow = months.map((month) => {
    running += month.net_inr;
    return { month: month.month, label: month.label, net_inr: month.net_inr, cumulative_inr: running };
  });
  const latest = statement.months.at(-1)!;
  const previous = statement.months.at(-2) ?? null;
  const latestRow = months.at(-1)!;

  const categories = Object.entries(latest.spending)
    .map(([category, amount]) => ({ category, amount_inr: amount }))
    .concat(latest.emi_inr ? [{ category: 'EMI', amount_inr: latest.emi_inr }] : [])
    .sort((a, b) => b.amount_inr - a.amount_inr);

  const loans = fixtures.loans.accounts[customerId]?.loans ?? [];
  const debts = twin.liabilities.map((line) => {
    const loan = loans.find((item) => line.label.includes(item.loan_id));
    return { name: line.label, outstanding_inr: line.value_inr, emi_inr: loan?.emi_inr ?? 0, kind: loan ? 'loan' : 'card' };
  });
  const upcoming = twin.obligations.filter((item) => item.direction === 'out');
  const upcomingTotal = upcoming.reduce((sum, item) => sum + item.amount_inr, 0);
  const goals = listGoals(customerId).filter((goal) => goal.status !== 'completed');

  const savingsRate = latestRow.income_inr ? latestRow.net_inr / latestRow.income_inr : 0;
  const health = healthScore({
    savingsRate,
    emiRatio: twin.cash_flow.emi_to_income,
    emergencyMonths: twin.emergency.months_covered,
    shortfall: twin.before_salary.shortfall_inr,
    dueBeforeSalary: twin.before_salary.due_inr,
  });

  const insights: ProactiveInsight[] = [];
  if (previous) {
    const before = monthSpending(previous);
    const change = before ? (latestRow.spending_inr - before) / before : 0;
    if (Math.abs(change) >= 0.05) {
      const drivers = Object.entries(latest.spending)
        .map(([category, amount]) => ({ category, delta: amount - (previous.spending[category] ?? 0) }))
        .sort((a, b) => (change > 0 ? b.delta - a.delta : a.delta - b.delta));
      const top = drivers[0];
      insights.push({
        id: 'spending-change',
        tone: change > 0 ? 'warn' : 'good',
        title: `Spending ${change > 0 ? 'rose' : 'fell'} ${Math.round(Math.abs(change) * 100)}% in ${monthName(latest.month)}`,
        detail: `${formatInr(latestRow.spending_inr)} against ${formatInr(before)} in ${monthName(previous.month)}${top && Math.abs(top.delta) > 0 ? `, mostly ${top.category} (${top.delta > 0 ? '+' : '-'}${formatInr(Math.abs(top.delta))})` : ''}.`,
        ask: 'Where did my spending go up last month?',
      });
    }
  }
  for (const item of upcoming.filter((obligation) => obligation.kind === 'emi' && obligation.days_away <= 7)) {
    insights.push({
      id: `emi-${item.due_date}`,
      tone: 'warn',
      title: `${item.title} of ${formatInr(item.amount_inr)} is due ${item.days_away === 0 ? 'today' : `in ${item.days_away} day${item.days_away === 1 ? '' : 's'}`}`,
      detail: `Due on ${formatDay(item.due_date)}.`,
      ask: `My EMI of ${formatInr(item.amount_inr)} is due on ${formatDay(item.due_date)}. Can I pay it on time?`,
    });
  }
  if (twin.before_salary.shortfall_inr > 0) {
    insights.push({
      id: 'cash-shortfall',
      tone: 'alert',
      title: `Possible cash shortfall of ${formatInr(twin.before_salary.shortfall_inr)}`,
      detail: `${formatInr(twin.before_salary.due_inr)} is due before your salary on ${formatDay(twin.before_salary.salary_date)}; your balance is ${formatInr(twin.before_salary.balance_inr)}.`,
      ask: 'I may be short of cash before my salary. What are my options?',
    });
  }
  insights.push({
    id: 'emergency-fund',
    tone: twin.emergency.months_covered >= 6 ? 'good' : twin.emergency.months_covered >= 3 ? 'info' : 'warn',
    title: `Your emergency fund covers ${twin.emergency.months_covered} months of expenses`,
    detail:
      twin.emergency.months_covered >= 6
        ? 'That meets the usual six-month guideline.'
        : `A common guideline is 3 to 6 months. You have ${formatInr(twin.emergency.savings_inr)} set aside.`,
    ask: twin.emergency.months_covered < 6 ? 'Help me build my emergency fund' : undefined,
  });
  for (const policy of twin.insurance.filter((item) => item.days_to_renewal >= 0 && item.days_to_renewal <= 30)) {
    insights.push({
      id: `renewal-${policy.policy}`,
      tone: 'info',
      title: `${policy.policy} renews in ${policy.days_to_renewal} days`,
      detail: `Premium ${formatInr(policy.premium_inr)} on ${formatDay(policy.renewal_date)}.`,
    });
  }

  return {
    as_of: twin.as_of,
    period: { month: latest.month, label: `${monthName(latest.month)} ${latest.month.slice(0, 4)}` },
    kpis: {
      income_inr: latestRow.income_inr,
      spending_inr: latestRow.spending_inr,
      savings_inr: latestRow.net_inr,
      savings_rate_pct: Math.round(savingsRate * 100),
      upcoming_obligations_inr: upcomingTotal,
      upcoming_count: upcoming.length,
      outstanding_debt_inr: twin.net_position.liabilities_inr,
      monthly_emi_inr: twin.cash_flow.emi_inr,
      health,
    },
    months,
    cash_flow: cashFlow,
    categories,
    debts,
    goals: goals.map((goal) => ({
      goal_id: goal.goal_id,
      name: goal.name,
      target_inr: goal.target_inr,
      saved_inr: goal.current_savings_inr,
      progress_pct: goal.progress_pct,
      status: goal.status,
    })),
    upcoming: upcoming.map((item) => ({ title: item.title, kind: item.kind, amount_inr: item.amount_inr, due_date: item.due_date, days_away: item.days_away })),
    insights,
    sources: [statement.source, twin.cash_flow.source],
  };
}

export type Insights = NonNullable<ReturnType<typeof buildInsights>>;
