import { fixtures } from './fixtures';
import { buildForecast } from './forecast';
import { buildTwin } from './twin';

// A compact, read-only snapshot of the customer's own accounts for the assistant to answer from.
// Every number here comes from the Financial Twin or the cash-flow forecast; derived figures the
// assistant may need (such as emergency-fund targets) are computed here so it never has to do maths.
export function accountFacts(customerId: string) {
  const twin = buildTwin(customerId, { audit: false });
  if (!twin) return null;
  const forecast = buildForecast(customerId);
  const essentials = twin.cash_flow.essentials_inr;
  const { schedule } = fixtures.documents.policy;
  return {
    as_of: twin.as_of,
    summary: twin.summary.headline,
    balance_inr: twin.before_salary.balance_inr,
    emergency_savings_inr: twin.emergency.savings_inr,
    emergency_months_covered: twin.emergency.months_covered,
    minimum_safety_buffer_inr: twin.emergency.buffer_inr,
    emergency_fund_target_3_months_inr: essentials * 3,
    emergency_fund_target_6_months_inr: essentials * 6,
    emergency_fund_gap_to_3_months_inr: Math.max(essentials * 3 - twin.emergency.savings_inr, 0),
    monthly: {
      income_inr: twin.cash_flow.income_inr,
      essential_spending_inr: essentials,
      emi_inr: twin.cash_flow.emi_inr,
      free_cash_inr: twin.cash_flow.free_cash_inr,
      emi_share_of_income_pct: Math.round(twin.cash_flow.emi_to_income * 100),
    },
    net_worth: twin.net_position,
    assets: twin.assets.map(({ label, value_inr }) => ({ label, value_inr })),
    loans_and_cards: twin.liabilities.map(({ label, value_inr }) => ({ label, outstanding_inr: value_inr })),
    next_salary: { date: twin.before_salary.salary_date, due_before_it_inr: twin.before_salary.due_inr, shortfall_before_it_inr: twin.before_salary.shortfall_inr },
    upcoming_payments: twin.obligations.slice(0, 10).map((item) => ({
      title: item.title,
      direction: item.direction,
      amount_inr: item.amount_inr,
      due_date: item.due_date,
      days_away: item.days_away,
    })),
    cash_forecast: forecast
      ? {
          headline: forecast.headline,
          lowest_balance_inr: forecast.lowest.balance_inr,
          lowest_on: forecast.lowest.date,
          safe_to_spend_before_payday_inr: forecast.safe_to_spend_inr,
          cheapest_fix: forecast.best_plan?.summary ?? null,
        }
      : null,
    health_policy: {
      sum_insured_inr: schedule.sum_insured_inr,
      room_rent_limit_per_day_inr: schedule.room_rent_limit_per_day_inr,
      deductible_per_claim_inr: schedule.deductible_per_claim_inr,
    },
    insurance: twin.insurance.map((policy) => ({ ...policy })),
    goals: twin.goals.map((goal) => ({
      goal: goal.goal,
      target_inr: goal.target_inr,
      saved_inr: goal.saved_inr,
      progress_pct: goal.progress_pct,
      monthly_needed_inr: goal.monthly_needed_inr,
      target_date: goal.target_date,
    })),
  };
}

export type AccountFacts = NonNullable<ReturnType<typeof accountFacts>>;
