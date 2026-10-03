// "Can I afford it?": deterministic scenarios (cash, EMI or loan, wait) for a purchase, judged against the
// customer's Financial Twin, affordability rules, emergency buffer, and the cash-flow forecast.
import { calculateEmi, checkAffordability, formatDay, formatInr } from './decision';
import { fixtures, type LenderOffer } from './fixtures';
import { buildForecast } from './forecast';

export type ScenarioStatus = 'comfortable' | 'manageable' | 'high_stress' | 'not_possible' | 'wait';

export interface AffordScenario {
  id: string;
  title: string;
  upfront_inr: number;
  monthly_emi_inr: number;
  months: number;
  extra_cost_inr: number;
  emi_to_income: number | null;
  savings_after_inr: number | null;
  status: ScenarioStatus;
  effect: string;
}

const UNITS: Record<string, number> = { crore: 1e7, cr: 1e7, lakh: 1e5, lakhs: 1e5, lac: 1e5, l: 1e5, k: 1e3, thousand: 1e3, hazaar: 1e3, hazar: 1e3 };

// "1.2 lakh", "₹1,20,000", "15L", "60k", "Rs 8 lakh" -> rupees.
export function parseIndianAmount(text: string): number | null {
  const unit = /(\d+(?:\.\d+)?)\s*(crore|cr|lakhs?|lac|l|k|thousand|hazaa?r)\b/i.exec(text);
  if (unit) return Math.round(Number(unit[1]) * UNITS[unit[2]!.toLowerCase()]!);
  const plain = /(?:₹|\binr\b|\brs\.?)\s*([0-9][0-9,]*)/i.exec(text) ?? /\b([0-9]{1,3}(?:,[0-9]{2,3})+|[0-9]{4,})\b/.exec(text);
  if (!plain) return null;
  const value = Number(plain[1]!.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}

export function purchaseCategory(text: string): 'vehicle' | 'purchase' {
  return /\b(car|bike|scooter|scooty|motorcycle|vehicle|gaadi|ev)\b|गाड़ी|कार/i.test(text) ? 'vehicle' : 'purchase';
}

export function assessAffordability(customerId: string, input: { amount_inr: number; item?: string; category?: 'vehicle' | 'purchase' }) {
  const profile = fixtures.profiles[customerId];
  const forecast = buildForecast(customerId);
  if (!profile || !forecast) return null;
  const amount = Math.round(input.amount_inr);
  const category = input.category ?? purchaseCategory(input.item ?? '');
  const rules = fixtures.lending.affordability_rules;

  // Money genuinely free today: balance left after bills due before payday, plus savings above the buffer.
  const freeBalance = Math.max(forecast.lowest.balance_inr, 0);
  const spareSavings = Math.max(profile.emergency_savings_inr - profile.minimum_emergency_buffer_inr, 0);
  const spare = freeBalance + spareSavings;
  const freeCash = profile.monthly_income_inr - profile.monthly_essential_expenses_inr - profile.existing_emi_inr;
  const savingsAfter = (spend: number) => profile.emergency_savings_inr - Math.max(spend - freeBalance, 0);

  const scenarios: AffordScenario[] = [];
  const cashSavingsAfter = savingsAfter(amount);
  scenarios.push({
    id: 'cash',
    title: 'Pay in full now',
    upfront_inr: amount,
    monthly_emi_inr: 0,
    months: 0,
    extra_cost_inr: 0,
    emi_to_income: null,
    savings_after_inr: cashSavingsAfter,
    status: amount <= spare ? 'comfortable' : cashSavingsAfter >= 0 ? 'high_stress' : 'not_possible',
    effect:
      amount <= spare
        ? `Leaves ${formatInr(cashSavingsAfter)} in savings, above your ${formatInr(profile.minimum_emergency_buffer_inr)} buffer.`
        : cashSavingsAfter >= 0
          ? `Possible, but savings fall to ${formatInr(cashSavingsAfter)}, below your ${formatInr(profile.minimum_emergency_buffer_inr)} safety buffer.`
          : `You have ${formatInr(freeBalance + profile.emergency_savings_inr)} available, ${formatInr(amount - freeBalance - profile.emergency_savings_inr)} short.`,
  });

  const loanScenario = (id: string, title: string, offer: LenderOffer, principal: number, down: number): AffordScenario | null => {
    if (principal < offer.min_amount_inr || principal > offer.max_amount_inr) return null;
    const emi = calculateEmi(principal, offer.annual_rate_pct, offer.tenure_months);
    const fee = Math.round((principal * offer.processing_fee_pct) / 100);
    const check = checkAffordability(profile, emi.emi_inr, rules);
    const downOk = down <= spare;
    const status: ScenarioStatus = !downOk ? 'not_possible' : !check.affordable ? 'high_stress' : check.total_emi_to_income <= 0.3 ? 'comfortable' : 'manageable';
    return {
      id,
      title,
      upfront_inr: down,
      monthly_emi_inr: emi.emi_inr,
      months: offer.tenure_months,
      extra_cost_inr: emi.total_interest_inr + fee,
      emi_to_income: check.total_emi_to_income,
      savings_after_inr: down ? savingsAfter(down) : profile.emergency_savings_inr,
      status,
      effect: !downOk
        ? `Needs ${formatInr(down)} upfront; only ${formatInr(spare)} is free without touching your buffer.`
        : `${formatInr(emi.emi_inr)} a month for ${offer.tenure_months} months; total EMIs would be ${Math.round(check.total_emi_to_income * 100)}% of income. ${check.affordable ? 'Passes' : 'Fails'} the affordability check.`,
    };
  };

  const offer = (kind: LenderOffer['kind']) => fixtures.lending.offers.find((candidate) => candidate.kind === kind);
  if (category === 'vehicle') {
    const vehicle = offer('vehicle');
    if (vehicle) {
      for (const share of [0.2, 0.1, 0]) {
        const down = Math.round(amount * share);
        const scenario = loanScenario(`vehicle_${share * 100}`, `${share ? `${share * 100}% down` : 'No down payment'} + ${vehicle.product.toLowerCase()}`, vehicle, amount - down, down);
        if (scenario) scenarios.push(scenario);
      }
    }
  } else {
    const card = offer('card_emi');
    const personal = offer('personal');
    const cardScenario = card ? loanScenario('card_emi', `${card.product}, ${card.tenure_months} months`, card, amount, 0) : null;
    const personalScenario = personal ? loanScenario('personal_loan', `${personal.product}, ${personal.tenure_months} months`, personal, amount, 0) : null;
    if (cardScenario) scenarios.push(cardScenario);
    if (personalScenario) scenarios.push(personalScenario);
  }

  const monthlySaving = Math.max(Math.round(freeCash * 0.5), 0);
  const waitMonths = monthlySaving ? Math.max(Math.ceil((amount - spare) / monthlySaving), 0) : null;
  if (waitMonths !== null && waitMonths > 0) {
    scenarios.push({
      id: 'wait',
      title: waitMonths > 36 ? 'Save for 3+ years, then buy' : `Save for ${waitMonths} month${waitMonths === 1 ? '' : 's'}, then buy`,
      upfront_inr: amount,
      monthly_emi_inr: 0,
      months: waitMonths,
      extra_cost_inr: 0,
      emi_to_income: null,
      savings_after_inr: profile.emergency_savings_inr,
      status: 'wait',
      effect: `Set aside ${formatInr(monthlySaving)} a month (half your free cash). No interest, buffer untouched.`,
    });
  }

  // Recommendation: cash if comfortable; a short wait beats borrowing; else the cheapest comfortable or manageable credit.
  const byCost = (a: AffordScenario, b: AffordScenario) => a.extra_cost_inr - b.extra_cost_inr;
  const cash = scenarios.find((scenario) => scenario.id === 'cash' && scenario.status === 'comfortable');
  const wait = scenarios.find((scenario) => scenario.id === 'wait');
  const credit = scenarios.filter((scenario) => scenario.status === 'comfortable').sort(byCost)[0] ??
    scenarios.filter((scenario) => scenario.status === 'manageable').sort(byCost)[0];
  const recommended = cash ?? (wait && wait.months <= 3 ? wait : credit ?? wait ?? null);
  const verdict = cash ? 'yes' : recommended && recommended.id !== 'wait' ? 'yes_with_plan' : wait && wait.months <= 3 ? 'yes_with_plan' : 'not_now';

  const label = input.item?.trim() || 'this purchase';
  const headline =
    verdict === 'yes'
      ? `Yes, you can buy ${label} for ${formatInr(amount)} from cash and keep your safety buffer.`
      : verdict === 'yes_with_plan'
        ? `Not from cash today, but "${recommended!.title}" works: ${recommended!.effect}`
        : `Not now: no option passes the safety checks.${wait ? ` Saving (${wait.title.toLowerCase()}) is the safe route.` : ''}`;

  return {
    customer_id: customerId,
    item: label,
    amount_inr: amount,
    category,
    verdict,
    headline,
    recommended_id: recommended?.id ?? null,
    scenarios,
    context: {
      free_balance_inr: freeBalance,
      spare_savings_inr: spareSavings,
      emergency_buffer_inr: profile.minimum_emergency_buffer_inr,
      free_cash_monthly_inr: freeCash,
      existing_emi_inr: profile.existing_emi_inr,
      monthly_income_inr: profile.monthly_income_inr,
    },
    warning:
      forecast.crunch_inr > 0
        ? `Fix this first: you may be ${formatInr(forecast.crunch_inr)} short on ${formatDay(forecast.lowest.date)}, before payday.`
        : null,
    method: 'Twin balances and cash flow, the forecast low point, lender offers, and the affordability rules. No model output.',
  };
}

export type AffordabilityAssessment = NonNullable<ReturnType<typeof assessAffordability>>;
