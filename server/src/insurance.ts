// Protection inputs for the term-life playbook, assembled from the Financial Twin, and the indicative
// term premium rate shared by the playbook and the insurer contract so the quote cannot drift.
import { fixtures } from './fixtures';
import { buildTwin } from './twin';

// Indicative annual premium per INR 1 lakh of cover, non-smoker, by age band (synthetic insurer table).
export function termRatePerLakh(age: number): number {
  if (age < 30) return 75;
  if (age < 40) return 110;
  if (age < 50) return 220;
  return 450;
}

export function termPremium(sumAssured: number, age: number): number {
  return Math.ceil(((sumAssured / 100_000) * termRatePerLakh(age)) / 10) * 10;
}

export function householdContext(customerId: string) {
  const twin = buildTwin(customerId, { audit: false });
  const profile = fixtures.profiles[customerId];
  if (!twin || !profile) return null;
  const household = twin.household ?? { age: 35, dependents: 0 };
  const lifeCover = twin.insurance.filter((policy) => policy.kind === 'life').reduce((sum, policy) => sum + policy.cover_inr, 0);
  const healthCover = twin.insurance.filter((policy) => policy.kind === 'health').reduce((sum, policy) => sum + policy.cover_inr, 0);
  return {
    age: household.age,
    dependents: household.dependents,
    annual_income_inr: profile.monthly_income_inr * 12,
    liabilities_inr: twin.net_position.liabilities_inr,
    liquid_assets_inr: twin.net_position.assets_inr,
    life_cover_inr: lifeCover,
    health_cover_inr: healthCover,
    free_cash_monthly_inr: twin.cash_flow.free_cash_inr,
    premium_rate_per_lakh: termRatePerLakh(household.age),
  };
}
