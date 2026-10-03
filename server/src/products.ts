import { calculateEmi } from './decision';
import { offersFor, PARTNERS } from './fixtures';
import { householdContext } from './insurance';
import type { CaseRecord } from './types';

const LOAN_TOOL = 'lending.submit_application';
const POLICY_TOOL = 'insurer.apply_term_plan';

// The loan or policy inside Saathi's recommended option, if there is one. Products are only offered here when the
// deterministic engine recommends them for this case; ranking never considers partner commission.
export function suggestedProduct(record: CaseRecord) {
  const decision = record.decision;
  const best = decision?.options.find((option) => option.option_id === decision.recommended_option_id);
  if (!decision || !best || !best.recommended || !best.feasible || best.handoff) return null;
  const otherSteps = (tool: string) => best.writes.filter((write) => write.tool !== tool).map((write) => write.summary);
  const base = {
    option_id: best.option_id,
    option_title: best.title,
    why: best.summary,
    simulated: true as const,
    commission_considered: false as const,
  };

  const loan = best.writes.find((write) => write.tool === LOAN_TOOL);
  if (loan) {
    const offerId = String(loan.input.offer_id ?? '');
    const amount = Number(loan.input.amount_inr ?? loan.amount_inr);
    const offer = offersFor(record.customer_id).find((candidate) => candidate.offer_id === offerId);
    if (!offer || !amount) return null;
    const emi = calculateEmi(amount, offer.annual_rate_pct, offer.tenure_months);
    const fee = Math.round((amount * offer.processing_fee_pct) / 100);
    return {
      ...base,
      kind: 'loan' as const,
      partner: PARTNERS.lender,
      product: offer.product,
      amount_inr: amount,
      interest_rate_pct: offer.annual_rate_pct,
      tenure_months: offer.tenure_months,
      monthly_emi_inr: emi.emi_inr,
      total_interest_inr: emi.total_interest_inr,
      processing_fee_inr: fee,
      total_payable_inr: amount + emi.total_interest_inr + fee,
      disbursal_days: offer.disbursal_days,
      disburse_to: offer.disburse_to,
      other_steps: otherSteps(LOAN_TOOL),
    };
  }

  const policy = best.writes.find((write) => write.tool === POLICY_TOOL);
  if (policy) {
    const household = householdContext(record.customer_id);
    const premium = Number(policy.input.annual_premium_inr ?? 0);
    const cover = Number(policy.input.sum_assured_inr ?? 0);
    const years = Number(policy.input.term_years ?? 0);
    if (!premium || !cover || !years) return null;
    return {
      ...base,
      kind: 'insurance' as const,
      partner: PARTNERS.insurer,
      product: 'Term life insurance',
      sum_assured_inr: cover,
      term_years: years,
      annual_premium_inr: premium,
      monthly_equivalent_inr: Math.round(premium / 12),
      cover_until_age: household ? household.age + years : null,
      other_steps: otherSteps(POLICY_TOOL),
    };
  }
  return null;
}

export type SuggestedProduct = NonNullable<ReturnType<typeof suggestedProduct>>;
