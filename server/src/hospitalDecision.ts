// Hospital and medical-bill plans. Every amount comes from the conversation (what the customer said), a bill they
// uploaded and confirmed, an insurer estimate against that bill, or their account records. Nothing is pre-filled.
import {
  FORMULA_VERSION,
  SCORE_WEIGHTS,
  calculateEmi,
  calculateExactGap,
  checkAffordability,
  confidenceGate,
  explainOptions,
  formatInr,
  humanSupportDraft,
  rankOptions,
  type OptionDraft,
} from './decision';
import type { AffordabilityRules, BillLine, FinancialProfile, LenderOffer } from './fixtures';
import type { Decision, Fact, PlannedWrite, SourceRef, Urgency } from './types';

const CLAIM_SETTLEMENT_DAYS = 7;

export interface SourcedValue {
  value: number;
  source: SourceRef;
  confidence: number;
  confirmed_by_customer?: boolean;
}

export interface HospitalBillInput extends SourcedValue {
  lines: BillLine[] | null;
  document_id: string | null;
  file_name: string | null;
}

export interface HospitalInsuranceInput extends SourcedValue {
  policy_document_id: string | null;
  policy_file_name: string | null;
  assumptions: { clause_id: string; page: number; title: string }[];
}

export interface HospitalDecisionInput {
  caseId: string;
  urgency: Urgency;
  bill: HospitalBillInput;
  // null when the customer has no insurance or chose to plan without it.
  insurance: HospitalInsuranceInput | null;
  contribution: SourcedValue;
  profile: FinancialProfile;
  offers: LenderOffer[];
  rules: AffordabilityRules;
  partners: { insurer: string; lender: string; hospital: string };
  // An earlier amount the customer mentioned, compared with a confirmed uploaded bill.
  statedBillInr: number | null;
  verification: { required: boolean; reason?: string };
  // Claim documents the hospital has not issued yet; Saathi asks for them once the customer approves.
  missingDocuments?: string[];
  // Mutual funds the customer could redeem, from consented Account Aggregator data.
  mutualFunds?: { name: string; value_inr: number }[];
  // Policy findings to surface with the plan, such as a room-rent cap.
  flags?: string[];
}

const MF_REDEMPTION_DAYS = 2;

const profileSource = (profile: FinancialProfile): SourceRef => ({ type: 'customer_profile', ref: profile.profile_id, document: profile.source });

export const CLAIM_DOCUMENT_GUIDANCE = [
  'Itemised final bill',
  'Discharge summary',
  'Doctor prescriptions and reports',
  'Pharmacy and lab receipts',
  'Photo ID and policy card',
];

export function computeHospitalDecision(input: HospitalDecisionInput): Decision {
  const { bill, insurance, profile, partners } = input;
  const warnings: string[] = [];
  let cover = insurance?.value ?? 0;
  if (cover > bill.value) {
    warnings.push(
      `The insurance amount (${formatInr(cover)}) is more than the bill (${formatInr(bill.value)}), so Saathi counts cover only up to the bill.`,
    );
    cover = bill.value;
  }
  const lines = bill.lines?.length ? bill.lines : [{ line: 1, description: 'Bill total', amount_inr: bill.value }];
  const calculation = calculateExactGap({
    bill_total_inr: bill.value,
    bill_line_total_inr: lines.reduce((sum, line) => sum + line.amount_inr, 0),
    coverage_estimate_inr: cover,
    customer_contribution_inr: input.contribution.value,
  });
  const gap = calculation.exact_gap_inr;
  const afterCover = bill.value - cover;
  const payNow = Math.min(input.contribution.value, afterCover);
  const insured = Boolean(insurance);

  const facts: Fact[] = [
    {
      name: 'bill_total_inr',
      label: bill.file_name ? 'Hospital bill total' : 'Hospital bill (as you told Saathi)',
      value: bill.value,
      unit: 'INR',
      source: bill.source,
      confidence: bill.confidence,
      confirmed_by_customer: bill.confirmed_by_customer,
    },
  ];
  if (insurance) {
    facts.push({
      name: 'estimated_coverage_inr',
      label: insurance.source.type === 'policy_clause' ? 'Insurer coverage estimate' : 'Expected insurance cover (as you told Saathi)',
      value: cover,
      unit: 'INR',
      source: insurance.source,
      confidence: insurance.confidence,
      confirmed_by_customer: insurance.confirmed_by_customer,
    });
  } else {
    facts.push({
      name: 'estimated_coverage_inr',
      label: 'Insurance cover',
      value: 0,
      unit: 'INR',
      source: { type: 'customer_statement', ref: 'No insurance payout counted in this plan' },
      confidence: 1,
      confirmed_by_customer: true,
    });
  }
  facts.push(
    {
      name: 'customer_contribution_inr',
      label: 'You can pay now',
      value: input.contribution.value,
      unit: 'INR',
      source: input.contribution.source,
      confidence: input.contribution.confidence,
      confirmed_by_customer: input.contribution.confirmed_by_customer,
    },
    {
      name: 'exact_gap_inr',
      label: 'Funding gap',
      value: gap,
      unit: 'INR',
      source: { type: 'calculation', ref: `${FORMULA_VERSION}: ${calculation.formula}` },
      confidence: Math.min(bill.confidence, insurance?.confidence ?? 1, input.contribution.confidence),
    },
    { name: 'monthly_income_inr', label: 'Monthly income', value: profile.monthly_income_inr, unit: 'INR', source: profileSource(profile), confidence: 0.9 },
    { name: 'existing_emi_inr', label: 'Existing EMIs', value: profile.existing_emi_inr, unit: 'INR', source: profileSource(profile), confidence: 0.9 },
    { name: 'emergency_savings_inr', label: 'Emergency savings', value: profile.emergency_savings_inr, unit: 'INR', source: profileSource(profile), confidence: 0.9 },
  );
  for (const assumption of insurance?.assumptions ?? []) {
    facts.push({
      name: `assumption_clause_${assumption.clause_id}`,
      label: assumption.title,
      value: 'Not applied to the estimate; insurer must confirm',
      source: { type: 'policy_clause', ref: `Clause ${assumption.clause_id}, page ${assumption.page}`, document: insurance?.policy_file_name },
      confidence: 0.6,
      assumption: true,
    });
  }

  if (input.statedBillInr && bill.file_name && input.statedBillInr !== bill.value) {
    warnings.push(
      `You first mentioned ${formatInr(input.statedBillInr)}, but the bill you confirmed shows ${formatInr(bill.value)}. Saathi uses the confirmed bill.`,
    );
  }
  if (insurance && insurance.source.type === 'customer_statement') {
    warnings.push('The insurance amount is your estimate. The insurer confirms the final payout, so the gap can change.');
  }
  warnings.push(...(input.flags ?? []));
  const missingDocuments = insurance ? (input.missingDocuments ?? []) : [];
  if (missingDocuments.length) {
    warnings.push(
      `Still missing for the claim: ${missingDocuments.join(', ').toLowerCase()}. Saathi files the claim now and asks the hospital for it once you approve.`,
    );
  }

  const gate = confidenceGate(facts, input.verification);
  const claimWrite: PlannedWrite | null = insurance
    ? {
        tool: 'claim.submit',
        partner: partners.insurer,
        amount_inr: bill.value,
        summary: `Submit a claim for the ${formatInr(bill.value)} bill (expected cover ${formatInr(cover)})`,
        input: {
          case_id: input.caseId,
          policy_document_id: insurance.policy_document_id ?? 'POLICY-ON-FILE',
          bill_document_id: bill.document_id ?? 'BILL-STATED',
          claimed_amount_inr: bill.value,
          estimated_coverage_inr: cover,
          pending_documents: missingDocuments,
        },
      }
    : null;
  const documentWrites: PlannedWrite[] = missingDocuments.map((document) => ({
    tool: 'hospital.request_document',
    partner: partners.hospital,
    amount_inr: 0,
    summary: `Ask the hospital for the ${document.toLowerCase()}`,
    input: { case_id: input.caseId, document },
  }));
  const claimWrites = claimWrite ? [claimWrite, ...documentWrites] : [];
  const payLink = (amount: number): PlannedWrite[] =>
    amount > 0
      ? [
          {
            tool: 'payments.create_link',
            partner: 'Paytm Payments (simulated)',
            amount_inr: amount,
            summary: `Pay your ${formatInr(amount)} share to the hospital with a Paytm payment link`,
            input: { case_id: input.caseId, amount_inr: amount, payee: 'hospital', purpose: `Patient share for the ${formatInr(bill.value)} bill` },
          },
        ]
      : [];
  const claimDocs = insured ? 'Keep the discharge summary, itemised bill, and pharmacy receipts ready for the claim.' : null;
  const claimStep = 'Approve the claim with your Resolution Passport';
  const payStep = payNow > 0 ? [`Pay the ${formatInr(payNow)} you can afford now`] : [];

  const drafts: OptionDraft[] = [];

  if (gap === 0) {
    drafts.push({
      option_id: insured ? 'claim_and_pay' : 'pay_in_full',
      title: insured ? 'Claim + pay the balance' : 'Pay the bill from your funds',
      summary: insured
        ? `Insurance and the ${formatInr(payNow)} you can pay now cover the bill. No credit is needed.`
        : `The ${formatInr(payNow)} you can pay covers the bill. No credit is needed.`,
      steps: [...(insured ? [claimStep] : []), ...(afterCover > 0 ? [`Pay ${formatInr(afterCover)} to the hospital`] : [])],
      metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 0, effort_steps: insured ? 2 : 1, risk: 'low' },
      guardrails: [gate],
      trade_offs: ['No borrowing and no interest.', ...(claimDocs ? [claimDocs] : [])],
      writes: [...claimWrites, ...payLink(afterCover)],
      handoff: false,
      self_serve: false,
    });
  }

  // The cheapest offer that can fund exactly the gap; options are never ranked by partner commission.
  const gapOffers = input.offers
    .filter((offer) => (offer.kind === 'exact_gap' || offer.kind === 'personal') && gap >= offer.min_amount_inr && gap <= offer.max_amount_inr)
    .map((offer) => {
      const emi = calculateEmi(gap, offer.annual_rate_pct, offer.tenure_months);
      const fee = Math.round((gap * offer.processing_fee_pct) / 100);
      return { offer, emi, fee, cost: emi.total_interest_inr + fee };
    })
    .sort((a, b) => a.cost - b.cost);
  const bestGapOffer = gap > 0 ? gapOffers[0] : undefined;
  let gapPlanExtraCost = 0;
  const fullOffer =
    insured && gap > 0
      ? input.offers
          .filter((offer) => offer.kind === 'personal' && bill.value >= offer.min_amount_inr && bill.value <= offer.max_amount_inr)
          .sort((a, b) => a.annual_rate_pct - b.annual_rate_pct)[0]
      : undefined;

  if (bestGapOffer) {
    const { offer, emi, fee } = bestGapOffer;
    const affordability = checkAffordability(profile, emi.emi_inr, input.rules);
    gapPlanExtraCost = emi.total_interest_inr + fee;
    drafts.push({
      option_id: insured ? 'claim_plus_gap_plan' : 'gap_plan',
      title: insured ? `Claim + ${offer.tenure_months}-month plan` : `${offer.tenure_months}-month plan for the gap`,
      summary:
        `${insured ? 'Claim from insurance, pay' : 'Pay'} ${formatInr(payNow)} now, and cover only the ${formatInr(gap)} gap ` +
        `with a ${offer.tenure_months}-month plan paid directly to the hospital.`,
      steps: [
        ...(insured ? [claimStep] : []),
        ...payStep,
        `Accept the ${formatInr(gap)} plan (EMI ${formatInr(emi.emi_inr)} for ${offer.tenure_months} months)`,
      ],
      metrics: {
        borrow_inr: gap,
        extra_cost_inr: gapPlanExtraCost,
        monthly_emi_inr: emi.emi_inr,
        time_to_funds_days: offer.disbursal_days,
        effort_steps: insured ? 3 : 2,
        risk: affordability.affordable ? 'low' : 'high',
      },
      guardrails: [
        gate,
        { rule: 'Affordability', passed: affordability.affordable, blocking: true, detail: affordability.detail },
        { rule: 'Borrow only the exact gap', passed: true, blocking: false, detail: `Borrows ${formatInr(gap)}, equal to the calculated gap.` },
      ],
      trade_offs: [
        ...(fullOffer ? [`${formatInr(bill.value - gap)} less borrowed than a full loan for the bill.`] : []),
        `It costs about ${formatInr(gapPlanExtraCost)} in interest and fees at ${offer.annual_rate_pct}% a year and keeps your emergency savings untouched.`,
        ...(claimDocs ? [claimDocs] : []),
      ],
      writes: [
        ...claimWrites,
        ...payLink(payNow),
        {
          tool: 'lending.submit_application',
          partner: partners.lender,
          amount_inr: gap,
          summary: `Apply for ${formatInr(gap)} over ${offer.tenure_months} months, paid to the hospital`,
          input: { case_id: input.caseId, offer_id: offer.offer_id, amount_inr: gap, tenure_months: offer.tenure_months, disburse_to: offer.disburse_to },
        },
      ],
      handoff: false,
      self_serve: false,
    });
  }

  if (gap > 0) {
    const savingsAfter = profile.emergency_savings_inr - gap;
    const enough = savingsAfter >= 0;
    const keepsBuffer = savingsAfter >= profile.minimum_emergency_buffer_inr;
    drafts.push({
      option_id: insured ? 'claim_plus_savings' : 'use_savings',
      title: insured ? 'Claim + use emergency savings' : 'Use emergency savings for the gap',
      summary: `${insured ? 'Claim from insurance, pay' : 'Pay'} ${formatInr(payNow)} now, and cover the ${formatInr(gap)} gap from savings.`,
      steps: [...(insured ? [claimStep] : []), ...payStep, `Move ${formatInr(gap)} from emergency savings`],
      metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 0, effort_steps: insured ? 3 : 2, risk: enough && keepsBuffer ? 'low' : 'high' },
      guardrails: [
        gate,
        {
          rule: 'Savings cover the gap',
          passed: enough,
          blocking: true,
          detail: `Emergency savings are ${formatInr(profile.emergency_savings_inr)}; the gap is ${formatInr(gap)}.`,
        },
        {
          rule: 'Keep the emergency buffer',
          passed: keepsBuffer,
          blocking: false,
          detail: `Using savings leaves ${formatInr(Math.max(savingsAfter, 0))}; your safety buffer is ${formatInr(profile.minimum_emergency_buffer_inr)}.`,
        },
      ],
      trade_offs: [
        keepsBuffer
          ? 'No interest, and your safety buffer stays intact.'
          : `No interest, but it leaves ${formatInr(Math.max(savingsAfter, 0))}, below your ${formatInr(profile.minimum_emergency_buffer_inr)} safety buffer.`,
        ...(claimDocs ? [claimDocs] : []),
      ],
      writes: [...claimWrites, ...payLink(payNow)],
      handoff: false,
      self_serve: false,
    });

    const funds = [...(input.mutualFunds ?? [])].sort((a, b) => b.value_inr - a.value_inr);
    const invested = funds.reduce((sum, fund) => sum + fund.value_inr, 0);
    if (funds.length) {
      drafts.push({
        option_id: insured ? 'claim_plus_redeem' : 'redeem_investments',
        title: insured ? 'Claim + redeem mutual funds' : 'Redeem mutual funds for the gap',
        summary: `${insured ? 'Claim from insurance, pay' : 'Pay'} ${formatInr(payNow)} now, and sell ${formatInr(gap)} of your mutual funds for the gap.`,
        steps: [...(insured ? [claimStep] : []), ...payStep, `Redeem ${formatInr(gap)} from ${funds[0]!.name}`],
        metrics: {
          borrow_inr: 0,
          extra_cost_inr: 0,
          monthly_emi_inr: 0,
          time_to_funds_days: MF_REDEMPTION_DAYS,
          effort_steps: insured ? 3 : 2,
          risk: 'medium',
        },
        guardrails: [
          gate,
          {
            rule: 'Enough invested',
            passed: invested >= gap,
            blocking: true,
            detail: `Your mutual funds are worth ${formatInr(invested)}; the gap is ${formatInr(gap)}.`,
          },
          {
            rule: 'Money arrives in time',
            passed: input.urgency !== 'high',
            blocking: false,
            detail: 'Mutual fund redemptions usually reach your bank in 1 to 3 working days, after an urgent hospital payment is due.',
          },
        ],
        trade_offs: [
          'No interest, but the money takes 1 to 3 working days and you sell units that were growing toward your goals.',
          'Exit load or capital-gains tax may apply; it is not included here.',
        ],
        writes: [...claimWrites, ...payLink(payNow)],
        handoff: false,
        self_serve: false,
      });
    }

    drafts.push({
      option_id: 'hospital_instalments',
      title: 'Ask the hospital for an instalment plan',
      summary: `Ask the hospital billing desk whether the ${formatInr(gap)} balance can be paid in parts after discharge.`,
      steps: ['Speak to the hospital billing or TPA desk', 'Get any instalment arrangement in writing'],
      metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 1, effort_steps: 2, risk: 'medium' },
      guardrails: [
        {
          rule: 'Hospital agrees',
          passed: true,
          blocking: false,
          detail: 'Not every hospital offers this; it depends on their policy.',
        },
      ],
      trade_offs: ['Usually no interest, but approval is at the hospital’s discretion and can take time.'],
      writes: [],
      handoff: false,
      self_serve: true,
    });
  }

  if (insured && gap > 0) {
    if (fullOffer) {
      const emi = calculateEmi(bill.value, fullOffer.annual_rate_pct, fullOffer.tenure_months);
      const fee = Math.round((bill.value * fullOffer.processing_fee_pct) / 100);
      const affordability = checkAffordability(profile, emi.emi_inr, input.rules);
      const extraCost = emi.total_interest_inr + fee;
      const overBorrow = bill.value - gap;
      drafts.push({
        option_id: 'full_bill_loan',
        title: `Borrow the full ${formatInr(bill.value)}`,
        summary: `Take a ${fullOffer.tenure_months}-month ${fullOffer.product.toLowerCase()} for the whole bill and use the claim payout to prepay later.`,
        steps: [`Apply for a ${formatInr(bill.value)} ${fullOffer.product.toLowerCase()}`, 'Pay the hospital in full', 'Submit the claim and use the payout to prepay the loan'],
        metrics: {
          borrow_inr: bill.value,
          extra_cost_inr: extraCost,
          monthly_emi_inr: emi.emi_inr,
          time_to_funds_days: fullOffer.disbursal_days,
          effort_steps: 3,
          risk: !affordability.affordable ? 'high' : overBorrow > 0 ? 'medium' : 'low',
        },
        guardrails: [
          gate,
          { rule: 'Affordability', passed: affordability.affordable, blocking: true, detail: affordability.detail },
          {
            rule: 'Borrow only the exact gap',
            passed: overBorrow <= 0,
            blocking: false,
            detail: `It borrows ${formatInr(overBorrow)} more than the calculated gap of ${formatInr(gap)}.`,
          },
        ],
        trade_offs: [
          gapPlanExtraCost > 0
            ? `It costs about ${formatInr(extraCost)}, roughly ${Math.max(Math.round(extraCost / gapPlanExtraCost), 1)}x the exact-gap plan.`
            : `It costs about ${formatInr(extraCost)} in interest and fees.`,
          `It borrows ${formatInr(overBorrow)} more than you need.`,
        ],
        writes: [
          {
            tool: 'lending.submit_application',
            partner: partners.lender,
            amount_inr: bill.value,
            summary: `Apply for ${formatInr(bill.value)} over ${fullOffer.tenure_months} months, paid to the hospital`,
            input: { case_id: input.caseId, offer_id: fullOffer.offer_id, amount_inr: bill.value, tenure_months: fullOffer.tenure_months, disburse_to: fullOffer.disburse_to },
          },
          ...claimWrites,
        ],
        handoff: false,
        self_serve: false,
      });
    }

    drafts.push({
      option_id: 'wait_for_claim',
      title: 'Wait for the claim settlement',
      summary: 'Submit the claim and ask the hospital to hold the balance until the insurer settles.',
      steps: [claimStep, 'Ask the hospital to hold the balance until settlement'],
      metrics: {
        borrow_inr: 0,
        extra_cost_inr: 0,
        monthly_emi_inr: 0,
        time_to_funds_days: CLAIM_SETTLEMENT_DAYS,
        effort_steps: 2,
        risk: input.urgency === 'high' ? 'high' : 'medium',
      },
      guardrails: [
        gate,
        {
          rule: 'Urgency check',
          passed: input.urgency !== 'high',
          blocking: false,
          detail: `Reimbursement claims commonly take about ${CLAIM_SETTLEMENT_DAYS} days or more (assumption), which can delay discharge.`,
        },
      ],
      trade_offs: ['No borrowing, but the hospital may not discharge until the balance is settled.', ...(claimDocs ? [claimDocs] : [])],
      writes: claimWrites,
      handoff: false,
      self_serve: false,
    });
  }

  drafts.push(humanSupportDraft(input.urgency, input.verification.required ? input.verification.reason : undefined));
  const options = rankOptions(drafts);
  return {
    formula_version: FORMULA_VERSION,
    computed_at: new Date().toISOString(),
    event_type: 'hospitalization',
    calculation,
    facts,
    options,
    recommended_option_id: options.find((option) => option.recommended)?.option_id ?? null,
    explanation: explainOptions(options),
    warnings,
    requires_verification: !gate.passed,
    commission_considered: false,
    weights: { ...SCORE_WEIGHTS },
  };
}
