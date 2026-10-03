// Cash-flow Copilot: a deterministic day-by-day balance forecast from the Financial Twin, the crunch it
// predicts before payday, and the cheapest combination of fixes that keeps the balance above zero.
import { calculateEmi, formatDay, formatInr } from './decision';
import { fixtures } from './fixtures';
import { buildTwin, type TwinObligation } from './twin';

export interface ForecastWhatIf {
  salary_delay_days?: number;
  skip?: string[];
}

export interface ForecastItem extends TwinObligation {
  id: string;
  flexible: boolean;
}

export interface ForecastDay {
  date: string;
  balance_inr: number;
  events: { id: string; title: string; amount_inr: number; direction: 'in' | 'out' }[];
}

export interface ForecastFix {
  id: string;
  title: string;
  detail: string;
  cost_inr: number;
  relief_inr: number;
  playbook_message: string | null;
}

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

// Bills a customer can usually shift or pay later without default; rent, school fees, and EMIs are not.
const FLEXIBLE_KINDS = new Set(['sip', 'bill', 'insurance']);
const CARD_MONTHLY_INTEREST = 0.035;
const CARD_MINIMUM_DUE_SHARE = 0.05;

const itemId = (item: TwinObligation) => `${item.kind}:${item.due_date}:${item.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

function series(start: string, horizonDays: number, openingBalance: number, items: ForecastItem[]): ForecastDay[] {
  const days: ForecastDay[] = [];
  let balance = openingBalance;
  for (let offset = 0; offset <= horizonDays; offset += 1) {
    const date = addDays(start, offset);
    const todays = items.filter((item) => item.due_date === date);
    for (const item of todays) balance += item.direction === 'in' ? item.amount_inr : -item.amount_inr;
    days.push({
      date,
      balance_inr: balance,
      events: todays.map((item) => ({ id: item.id, title: item.title, amount_inr: item.amount_inr, direction: item.direction })),
    });
  }
  return days;
}

function lowestBefore(days: ForecastDay[], cutoff: string): ForecastDay {
  const window = days.filter((day) => day.date < cutoff);
  return (window.length ? window : days).reduce((low, day) => (day.balance_inr < low.balance_inr ? day : low));
}

export function buildForecast(customerId: string, whatIf: ForecastWhatIf = {}, horizonDays = 30) {
  const twin = buildTwin(customerId, { audit: false });
  if (!twin) return null;
  const delay = Math.max(0, Math.min(whatIf.salary_delay_days ?? 0, 20));
  const skip = new Set(whatIf.skip ?? []);
  const today = twin.as_of;
  const end = addDays(today, horizonDays);

  const allItems: ForecastItem[] = twin.obligations.map((item) => ({
    ...item,
    id: itemId(item),
    flexible: FLEXIBLE_KINDS.has(item.kind),
    due_date: item.kind === 'salary' ? addDays(item.due_date, delay) : item.due_date,
  }));
  const items = allItems.filter((item) => item.due_date <= end && !skip.has(item.id));
  const salary = items.find((item) => item.kind === 'salary');
  const payday = salary?.due_date ?? end;

  const days = series(today, horizonDays, twin.before_salary.balance_inr, items);
  const low = lowestBefore(days, addDays(payday, 1));
  const firstNegative = days.find((day) => day.balance_inr < 0 && day.date < payday) ?? null;
  const crunch = Math.max(-low.balance_inr, 0);
  const safeToSpend = Math.max(low.balance_inr, 0);

  // Candidate fixes, each priced and measured by how much it lifts the pre-payday low point.
  const preSalary = items.filter((item) => item.direction === 'out' && item.due_date < payday);
  const fixes: ForecastFix[] = [];
  const loans = fixtures.loans.accounts[customerId]?.loans ?? [];
  for (const emi of preSalary.filter((item) => item.kind === 'emi')) {
    const loan = loans.find((candidate) => emi.title.startsWith(candidate.product));
    if (loan?.due_date_shift.allowed) {
      fixes.push({
        id: 'shift_emi',
        title: `Move the ${formatInr(emi.amount_inr)} EMI past payday`,
        detail: `Ask the lender to move ${loan.loan_id} from ${formatDay(emi.due_date)} to ${formatDay(addDays(payday, 1))} (up to ${loan.due_date_shift.max_days} days allowed).`,
        cost_inr: loan.due_date_shift.fee_inr,
        relief_inr: emi.amount_inr,
        playbook_message: `Salary delayed hai aur ${formatInr(emi.amount_inr)} ki EMI ${emi.due_date} ko due hai. Kya options hain?`,
      });
    }
  }
  for (const card of preSalary.filter((item) => item.kind === 'credit_card')) {
    const minimum = Math.ceil(card.amount_inr * CARD_MINIMUM_DUE_SHARE);
    const carried = card.amount_inr - minimum;
    fixes.push({
      id: 'card_minimum',
      title: `Pay the card's minimum due (${formatInr(minimum)}) now, the rest after payday`,
      detail: `Carries ${formatInr(carried)} for about a month at roughly ${(CARD_MONTHLY_INTEREST * 100).toFixed(1)}% a month. Avoids a late fee, but it is expensive credit.`,
      cost_inr: Math.round(carried * CARD_MONTHLY_INTEREST),
      relief_inr: carried,
      playbook_message: null,
    });
  }
  for (const bill of preSalary.filter((item) => item.flexible)) {
    fixes.push({
      id: `defer:${bill.id}`,
      title: `Move ${bill.title} to after payday`,
      detail: `Reschedule the ${formatInr(bill.amount_inr)} payment to ${formatDay(addDays(payday, 1))}.`,
      cost_inr: 0,
      relief_inr: bill.amount_inr,
      playbook_message: null,
    });
  }
  const profile = fixtures.profiles[customerId]!;
  const spareSavings = Math.max(profile.emergency_savings_inr - profile.minimum_emergency_buffer_inr, 0);
  if (crunch > 0 && spareSavings > 0) {
    fixes.push({
      id: 'use_savings',
      title: `Use up to ${formatInr(Math.min(spareSavings, crunch))} of savings above your buffer`,
      detail: `Keeps your ${formatInr(profile.minimum_emergency_buffer_inr)} emergency buffer intact.`,
      cost_inr: 0,
      relief_inr: Math.min(spareSavings, crunch),
      playbook_message: null,
    });
  }
  const bridge = fixtures.lending.offers.find((offer) => offer.kind === 'bridge');
  if (crunch > 0 && bridge && crunch >= bridge.min_amount_inr && crunch <= bridge.max_amount_inr) {
    const emi = calculateEmi(crunch, bridge.annual_rate_pct, bridge.tenure_months);
    fixes.push({
      id: 'bridge_loan',
      title: `Borrow only the ${formatInr(crunch)} shortfall for one month`,
      detail: `${bridge.product}: repay ${formatInr(emi.emi_inr)} after payday. Credit is the last resort.`,
      cost_inr: emi.total_interest_inr + Math.round((crunch * bridge.processing_fee_pct) / 100),
      relief_inr: crunch,
      playbook_message: null,
    });
  }

  // Cheapest set of fixes whose combined relief covers the crunch (exhaustive over at most 2^n small sets).
  const cheapest = (allowLoan: boolean): { fixes: ForecastFix[]; cost: number } | null => {
    let found: { fixes: ForecastFix[]; cost: number } | null = null;
    const candidates = fixes.filter((fix) => allowLoan || fix.id !== 'bridge_loan').slice(0, 10);
    for (let mask = 1; mask < 1 << candidates.length; mask += 1) {
      const chosen = candidates.filter((_, index) => mask & (1 << index));
      if (chosen.some((fix) => fix.id === 'bridge_loan') && chosen.length > 1) continue;
      const relief = chosen.reduce((sum, fix) => sum + fix.relief_inr, 0);
      const cost = chosen.reduce((sum, fix) => sum + fix.cost_inr, 0);
      if (relief < crunch) continue;
      if (!found || cost < found.cost || (cost === found.cost && chosen.length < found.fixes.length)) found = { fixes: chosen, cost };
    }
    return found;
  };
  const best = crunch > 0 ? cheapest(true) : null;
  const withoutLoan = crunch > 0 ? cheapest(false) : null;
  const describe = (plan: { fixes: ForecastFix[]; cost: number }) => ({
    fix_ids: plan.fixes.map((fix) => fix.id),
    cost_inr: plan.cost,
    summary: `${plan.fixes.map((fix) => fix.title).join(' + ')}: covers the ${formatInr(crunch)} shortfall for about ${formatInr(plan.cost)}.`,
  });

  return {
    customer_id: customerId,
    as_of: today,
    horizon_days: horizonDays,
    what_if: { salary_delay_days: delay, skip: [...skip] },
    opening_balance_inr: twin.before_salary.balance_inr,
    payday,
    salary_inr: salary?.amount_inr ?? 0,
    days,
    lowest: { date: low.date, balance_inr: low.balance_inr },
    first_negative_date: firstNegative?.date ?? null,
    crunch_inr: crunch,
    safe_to_spend_inr: safeToSpend,
    end_balance_inr: days.at(-1)!.balance_inr,
    items: allItems.filter((item) => item.due_date <= end),
    fixes,
    best_plan: best ? describe(best) : null,
    plan_without_new_loan: withoutLoan && best && withoutLoan.fixes.map((fix) => fix.id).join() !== best.fixes.map((fix) => fix.id).join() ? describe(withoutLoan) : null,
    headline:
      crunch > 0
        ? `You may be ${formatInr(crunch)} short on ${formatDay(low.date)}, before your salary on ${formatDay(payday)}.`
        : `You stay above zero until payday; you can safely spend up to ${formatInr(safeToSpend)} before ${formatDay(payday)}.`,
    method: 'Opening balance plus scheduled salary, bills, EMIs, SIPs, and card dues from the Financial Twin. No model output.',
  };
}

export type CashForecast = NonNullable<ReturnType<typeof buildForecast>>;
