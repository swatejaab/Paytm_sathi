import type { AffordabilityRules, BillLine, FinancialProfile, LenderOffer, LoanAccount, LoanContext } from './fixtures';
import { classifyWithPlaybooks } from './playbooks/registry';
import type {
  Decision,
  EventType,
  Fact,
  GapCalculation,
  Guardrail,
  PlannedWrite,
  Playbook,
  ResolutionOption,
  RiskLevel,
  Transaction,
  Urgency,
} from './types';

export const FORMULA_VERSION = 'saathi-decision-v1';
export const SCORE_WEIGHTS = { cost: 0.35, risk: 0.3, time: 0.2, effort: 0.15 } as const;
export const CONFIDENCE_THRESHOLD = 0.75;
const RISK_POINTS: Record<RiskLevel, number> = { low: 100, medium: 60, high: 20 };
const CLAIM_SETTLEMENT_DAYS = 7;

const round1 = (value: number): number => Math.round(value * 10) / 10;
const clamp = (value: number): number => Math.min(100, Math.max(0, value));

export function formatInr(amount: number): string {
  return `INR ${Math.round(amount).toLocaleString('en-IN')}`;
}

export function calculateEmi(principal: number, annualRatePct: number, months: number) {
  if (principal <= 0 || months <= 0) return { emi_inr: 0, total_interest_inr: 0 };
  const monthlyRate = annualRatePct / 1200;
  const emi =
    monthlyRate === 0
      ? principal / months
      : (principal * monthlyRate * (1 + monthlyRate) ** months) / ((1 + monthlyRate) ** months - 1);
  const emiInr = Math.round(emi);
  return { emi_inr: emiInr, total_interest_inr: Math.max(emiInr * months - principal, 0) };
}

export function calculateExactGap(input: {
  bill_total_inr: number;
  bill_line_total_inr: number;
  coverage_estimate_inr: number;
  customer_contribution_inr: number;
}): GapCalculation {
  const values = [input.bill_total_inr, input.coverage_estimate_inr, input.customer_contribution_inr];
  if (input.bill_total_inr !== input.bill_line_total_inr) {
    throw new Error('Bill lines do not reconcile to the stated total.');
  }
  if (values.some((value) => !Number.isFinite(value) || value < 0) || input.coverage_estimate_inr > input.bill_total_inr) {
    throw new Error('Financial values are outside valid bounds.');
  }
  return {
    bill_total_inr: input.bill_total_inr,
    coverage_estimate_inr: input.coverage_estimate_inr,
    customer_contribution_inr: input.customer_contribution_inr,
    exact_gap_inr: Math.max(input.bill_total_inr - input.coverage_estimate_inr - input.customer_contribution_inr, 0),
    formula: 'max(bill_total - coverage_estimate - customer_contribution, 0)',
  };
}

export function checkAffordability(profile: FinancialProfile, newEmiInr: number, rules: AffordabilityRules) {
  const freeCashFlow = profile.monthly_income_inr - profile.monthly_essential_expenses_inr - profile.existing_emi_inr;
  const maxNewEmi = Math.max(Math.floor(freeCashFlow * rules.max_new_emi_share_of_free_cash), 0);
  const totalEmiToIncome =
    profile.monthly_income_inr > 0 ? (profile.existing_emi_inr + newEmiInr) / profile.monthly_income_inr : 1;
  const affordable = newEmiInr <= maxNewEmi && totalEmiToIncome <= rules.max_total_emi_to_income;
  return {
    affordable,
    free_cash_flow_inr: freeCashFlow,
    max_new_emi_inr: maxNewEmi,
    total_emi_to_income: Math.round(totalEmiToIncome * 1000) / 1000,
    detail:
      `New EMI ${formatInr(newEmiInr)} against a safe limit of ${formatInr(maxNewEmi)}; ` +
      `total EMIs would be ${Math.round(totalEmiToIncome * 100)}% of income ` +
      `(limit ${Math.round(rules.max_total_emi_to_income * 100)}%).`,
  };
}

export type OptionDraft = Omit<ResolutionOption, 'scores' | 'feasible' | 'recommended'>;

export function rankOptions(drafts: OptionDraft[]): ResolutionOption[] {
  const maxExtraCost = Math.max(0, ...drafts.map((draft) => draft.metrics.extra_cost_inr));
  const ranked = drafts.map((draft): ResolutionOption => {
    const cost = maxExtraCost === 0 ? 100 : clamp(100 * (1 - draft.metrics.extra_cost_inr / maxExtraCost));
    const risk = RISK_POINTS[draft.metrics.risk];
    const time = clamp(100 - draft.metrics.time_to_funds_days * 10);
    const effort = clamp(100 - draft.metrics.effort_steps * 15);
    const total =
      cost * SCORE_WEIGHTS.cost + risk * SCORE_WEIGHTS.risk + time * SCORE_WEIGHTS.time + effort * SCORE_WEIGHTS.effort;
    return {
      ...draft,
      scores: { cost: round1(cost), risk, time: round1(time), effort: round1(effort), total: round1(total) },
      feasible: draft.guardrails.every((guardrail) => guardrail.passed || !guardrail.blocking),
      recommended: false,
    };
  });
  ranked.sort((a, b) => Number(b.feasible) - Number(a.feasible) || b.scores.total - a.scores.total);
  const best = ranked.find((option) => option.feasible && !option.self_serve) ?? ranked.find((option) => option.feasible);
  if (best) best.recommended = true;
  return ranked;
}

export function explainOptions(options: ResolutionOption[]): string {
  const best = options.find((option) => option.recommended);
  if (!best) return 'No option passes the safety guardrails. A Saathi specialist should review this case.';
  const runnerUp =
    options.find((option) => option.feasible && !option.recommended && !option.handoff && !option.self_serve) ??
    options.find((option) => option.feasible && !option.recommended);
  const failed = runnerUp?.guardrails.find((guardrail) => !guardrail.passed);
  let text = `${best.title} scores highest at ${best.scores.total}/100. ${best.summary}`;
  if (best.trade_offs[0]) text += ` ${best.trade_offs[0]}`;
  if (runnerUp) {
    text += ` Next best is ${runnerUp.title} (${runnerUp.scores.total}/100)`;
    text += failed ? `: ${failed.detail}` : '.';
  }
  return text;
}

export function humanSupportDraft(urgency: Urgency, reason?: string): OptionDraft {
  return {
    option_id: 'human_support',
    title: 'Talk to a Saathi specialist',
    summary: 'Share your Resolution Passport with a human specialist who continues from the same facts.',
    steps: ['Approve sharing your Resolution Passport with a specialist'],
    metrics: {
      borrow_inr: 0,
      extra_cost_inr: 0,
      monthly_emi_inr: 0,
      time_to_funds_days: 1,
      effort_steps: 1,
      risk: urgency === 'high' ? 'medium' : 'low',
    },
    guardrails: [
      {
        rule: 'No financial commitment',
        passed: true,
        blocking: false,
        detail: reason ?? 'A specialist reviews the case before any claim, credit, or dispute step.',
      },
    ],
    trade_offs: [
      'You do not repeat your story; the specialist receives the same source-linked passport.',
      urgency === 'high'
        ? 'A specialist callback takes up to one working day in this demo, which can delay urgent steps.'
        : 'A specialist responds within one working day in this demo.',
    ],
    writes: [],
    handoff: true,
    self_serve: false,
  };
}

function confidenceGate(facts: Fact[], forced: { required: boolean; reason?: string }): Guardrail {
  const weakFacts = facts.filter((fact) => !fact.assumption && fact.confidence < CONFIDENCE_THRESHOLD);
  if (forced.required || weakFacts.length) {
    return {
      rule: 'Evidence confidence gate',
      passed: false,
      blocking: true,
      detail:
        forced.reason ??
        `Low-confidence evidence (${weakFacts.map((fact) => fact.label).join(', ')}) must be verified by a specialist.`,
    };
  }
  return {
    rule: 'Evidence confidence gate',
    passed: true,
    blocking: true,
    detail: `Key facts meet the ${CONFIDENCE_THRESHOLD} confidence threshold.`,
  };
}

export interface HospitalDecisionInput {
  caseId: string;
  urgency: Urgency;
  bill: { document_id: string; file_name: string; total_inr: number; lines: BillLine[] };
  coverage: {
    estimated_coverage_inr: number;
    clause_id: string;
    page: number;
    confidence: number;
    policy_document_id: string;
    policy_file_name: string;
  };
  assumptions: { clause_id: string; page: number; title: string }[];
  claimChecklist: { clause_id: string; page: number; missing: string[] };
  profile: FinancialProfile;
  offers: LenderOffer[];
  rules: AffordabilityRules;
  partners: { insurer: string; lender: string; hospital: string };
  statedAmountInr: number | null;
  verification: { required: boolean; reason?: string };
}

export function computeHospitalDecision(input: HospitalDecisionInput): Decision {
  const { bill, coverage, profile, partners } = input;
  const calculation = calculateExactGap({
    bill_total_inr: bill.total_inr,
    bill_line_total_inr: bill.lines.reduce((sum, line) => sum + line.amount_inr, 0),
    coverage_estimate_inr: coverage.estimated_coverage_inr,
    customer_contribution_inr: profile.available_to_pay_inr,
  });
  const gap = calculation.exact_gap_inr;
  const contribution = calculation.customer_contribution_inr;
  const lineRange = bill.lines.length
    ? `Lines ${bill.lines[0]!.line}-${bill.lines[bill.lines.length - 1]!.line}`
    : 'Bill total';
  const missing = input.claimChecklist.missing;

  const facts: Fact[] = [
    {
      name: 'bill_total_inr',
      label: 'Hospital bill total',
      value: bill.total_inr,
      unit: 'INR',
      source: { type: 'bill_line', ref: lineRange, document: bill.file_name },
      confidence: 0.99,
    },
    {
      name: 'estimated_coverage_inr',
      label: 'Policy coverage estimate',
      value: coverage.estimated_coverage_inr,
      unit: 'INR',
      source: { type: 'policy_clause', ref: `Clause ${coverage.clause_id}, page ${coverage.page}`, document: coverage.policy_file_name },
      confidence: coverage.confidence,
    },
    {
      name: 'customer_contribution_inr',
      label: 'You can pay now',
      value: contribution,
      unit: 'INR',
      source: { type: 'customer_profile', ref: profile.profile_id, document: profile.source },
      confidence: 0.95,
    },
    {
      name: 'exact_gap_inr',
      label: 'Exact funding gap',
      value: gap,
      unit: 'INR',
      source: { type: 'calculation', ref: `${FORMULA_VERSION}: ${calculation.formula}` },
      confidence: Math.min(0.99, coverage.confidence, 0.95),
    },
    {
      name: 'monthly_income_inr',
      label: 'Monthly income',
      value: profile.monthly_income_inr,
      unit: 'INR',
      source: { type: 'customer_profile', ref: profile.profile_id, document: profile.source },
      confidence: 0.9,
    },
    {
      name: 'existing_emi_inr',
      label: 'Existing EMIs',
      value: profile.existing_emi_inr,
      unit: 'INR',
      source: { type: 'customer_profile', ref: profile.profile_id, document: profile.source },
      confidence: 0.9,
    },
    {
      name: 'emergency_savings_inr',
      label: 'Emergency savings',
      value: profile.emergency_savings_inr,
      unit: 'INR',
      source: { type: 'customer_profile', ref: profile.profile_id, document: profile.source },
      confidence: 0.9,
    },
    ...input.assumptions.map(
      (assumption): Fact => ({
        name: `assumption_clause_${assumption.clause_id}`,
        label: assumption.title,
        value: 'Not applied to the estimate; insurer must confirm',
        source: { type: 'policy_clause', ref: `Clause ${assumption.clause_id}, page ${assumption.page}`, document: coverage.policy_file_name },
        confidence: 0.6,
        assumption: true,
      }),
    ),
    ...missing.map(
      (document): Fact => ({
        name: 'missing_document',
        label: 'Missing claim document',
        value: document,
        source: { type: 'document_checklist', ref: `Clause ${input.claimChecklist.clause_id}, page ${input.claimChecklist.page}`, document: coverage.policy_file_name },
        confidence: 0.9,
      }),
    ),
  ];

  const warnings: string[] = [];
  if (input.statedAmountInr && input.statedAmountInr !== bill.total_inr) {
    warnings.push(
      `You mentioned ${formatInr(input.statedAmountInr)}, but the itemized bill shows ${formatInr(bill.total_inr)}. ` +
        'Saathi uses the bill and will confirm the difference with you.',
    );
  }

  const gate = confidenceGate(facts, input.verification);
  const documentWrites: PlannedWrite[] = missing.map((document) => ({
    tool: 'hospital.request_document',
    partner: partners.hospital,
    amount_inr: 0,
    summary: `Request the ${document.toLowerCase()} from the hospital`,
    input: { case_id: input.caseId, document },
  }));
  const claimWrite: PlannedWrite = {
    tool: 'claim.submit',
    partner: partners.insurer,
    amount_inr: bill.total_inr,
    summary: `Submit a claim for the ${formatInr(bill.total_inr)} bill (estimated cover ${formatInr(coverage.estimated_coverage_inr)})`,
    input: {
      case_id: input.caseId,
      policy_document_id: coverage.policy_document_id,
      bill_document_id: bill.document_id,
      claimed_amount_inr: bill.total_inr,
      estimated_coverage_inr: coverage.estimated_coverage_inr,
      pending_documents: missing,
    },
  };
  const documentTradeOff = missing.length
    ? `The claim still needs: ${missing.join(', ')}. Saathi requests it from the hospital.`
    : 'The claim document set is complete.';

  const pickOffer = (kind: LenderOffer['kind'], amount: number) =>
    input.offers.find((offer) => offer.kind === kind && amount >= offer.min_amount_inr && amount <= offer.max_amount_inr);

  const drafts: OptionDraft[] = [];
  const gapOffer = gap > 0 ? pickOffer('exact_gap', gap) : undefined;
  let gapPlanExtraCost = 0;

  if (gap === 0) {
    drafts.push({
      option_id: 'claim_and_pay',
      title: 'Claim + pay the balance',
      summary: `Insurance and the ${formatInr(contribution)} you can pay now cover the bill. No credit is needed.`,
      steps: ['Approve the claim with your Resolution Passport', `Pay ${formatInr(bill.total_inr - coverage.estimated_coverage_inr)} to the hospital`],
      metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 0, effort_steps: 2, risk: 'low' },
      guardrails: [gate],
      trade_offs: ['No borrowing and no interest.', documentTradeOff],
      writes: [...documentWrites, claimWrite],
      handoff: false,
      self_serve: false,
    });
  }

  if (gapOffer) {
    const emi = calculateEmi(gap, gapOffer.annual_rate_pct, gapOffer.tenure_months);
    const fee = Math.round((gap * gapOffer.processing_fee_pct) / 100);
    const affordability = checkAffordability(profile, emi.emi_inr, input.rules);
    gapPlanExtraCost = emi.total_interest_inr + fee;
    drafts.push({
      option_id: 'claim_plus_gap_plan',
      title: `Claim + ${gapOffer.tenure_months}-month plan`,
      summary:
        `Claim from insurance, pay ${formatInr(contribution)} now, and cover only the ${formatInr(gap)} gap ` +
        `with a ${gapOffer.tenure_months}-month plan paid directly to the hospital.`,
      steps: [
        'Approve the claim with your Resolution Passport',
        `Pay the ${formatInr(contribution)} you can afford now`,
        `Accept the ${formatInr(gap)} plan (EMI ${formatInr(emi.emi_inr)} for ${gapOffer.tenure_months} months)`,
      ],
      metrics: {
        borrow_inr: gap,
        extra_cost_inr: gapPlanExtraCost,
        monthly_emi_inr: emi.emi_inr,
        time_to_funds_days: gapOffer.disbursal_days,
        effort_steps: 3,
        risk: affordability.affordable ? 'low' : 'high',
      },
      guardrails: [
        gate,
        { rule: 'Affordability', passed: affordability.affordable, blocking: true, detail: affordability.detail },
        { rule: 'Borrow only the exact gap', passed: true, blocking: false, detail: `Borrows ${formatInr(gap)}, equal to the verified gap.` },
      ],
      trade_offs: [
        `It costs about ${formatInr(gapPlanExtraCost)} in interest and fees and keeps your emergency savings untouched.`,
        documentTradeOff,
      ],
      writes: [
        ...documentWrites,
        claimWrite,
        {
          tool: 'lending.submit_application',
          partner: partners.lender,
          amount_inr: gap,
          summary: `Apply for ${formatInr(gap)} over ${gapOffer.tenure_months} months, paid to the hospital`,
          input: {
            case_id: input.caseId,
            offer_id: gapOffer.offer_id,
            amount_inr: gap,
            tenure_months: gapOffer.tenure_months,
            disburse_to: gapOffer.disburse_to,
          },
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
      option_id: 'claim_plus_savings',
      title: 'Claim + use emergency savings',
      summary: `Claim from insurance, pay ${formatInr(contribution)} now, and cover the ${formatInr(gap)} gap from savings.`,
      steps: [
        'Approve the claim with your Resolution Passport',
        `Pay the ${formatInr(contribution)} you can afford now`,
        `Move ${formatInr(gap)} from emergency savings`,
      ],
      metrics: {
        borrow_inr: 0,
        extra_cost_inr: 0,
        monthly_emi_inr: 0,
        time_to_funds_days: 0,
        effort_steps: 3,
        risk: enough && keepsBuffer ? 'low' : 'high',
      },
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
        documentTradeOff,
      ],
      writes: [...documentWrites, claimWrite],
      handoff: false,
      self_serve: false,
    });
  }

  const fullOffer = pickOffer('personal', bill.total_inr);
  if (fullOffer) {
    const emi = calculateEmi(bill.total_inr, fullOffer.annual_rate_pct, fullOffer.tenure_months);
    const fee = Math.round((bill.total_inr * fullOffer.processing_fee_pct) / 100);
    const affordability = checkAffordability(profile, emi.emi_inr, input.rules);
    const extraCost = emi.total_interest_inr + fee;
    const overBorrow = bill.total_inr - gap;
    drafts.push({
      option_id: 'full_bill_loan',
      title: `Borrow the full ${formatInr(bill.total_inr)}`,
      summary: `Take a ${fullOffer.tenure_months}-month personal loan for the whole bill and use the claim payout to prepay later.`,
      steps: [
        `Apply for a ${formatInr(bill.total_inr)} personal loan`,
        'Pay the hospital in full',
        'Submit the claim and use the payout to prepay the loan',
      ],
      metrics: {
        borrow_inr: bill.total_inr,
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
          detail: `It borrows ${formatInr(overBorrow)} more than the verified gap of ${formatInr(gap)}.`,
        },
      ],
      trade_offs: [
        gapPlanExtraCost > 0
          ? `It costs about ${formatInr(extraCost)}, roughly ${Math.round(extraCost / gapPlanExtraCost)}x the exact-gap plan.`
          : `It costs about ${formatInr(extraCost)} in interest and fees.`,
        `It borrows ${formatInr(overBorrow)} more than you need.`,
      ],
      writes: [
        ...documentWrites,
        {
          tool: 'lending.submit_application',
          partner: partners.lender,
          amount_inr: bill.total_inr,
          summary: `Apply for ${formatInr(bill.total_inr)} over ${fullOffer.tenure_months} months, paid to the hospital`,
          input: {
            case_id: input.caseId,
            offer_id: fullOffer.offer_id,
            amount_inr: bill.total_inr,
            tenure_months: fullOffer.tenure_months,
            disburse_to: fullOffer.disburse_to,
          },
        },
        claimWrite,
      ],
      handoff: false,
      self_serve: false,
    });
  }

  if (gap > 0) {
    drafts.push({
      option_id: 'wait_for_claim',
      title: 'Wait for the claim settlement',
      summary: 'Submit the claim and ask the hospital to hold the balance until the insurer settles.',
      steps: ['Approve the claim with your Resolution Passport', 'Ask the hospital to hold the balance until settlement'],
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
          detail: `Settlement takes about ${CLAIM_SETTLEMENT_DAYS} days in this demo (assumption), which can delay discharge.`,
        },
      ],
      trade_offs: ['No borrowing, but the hospital may not discharge until the balance is settled.', documentTradeOff],
      writes: [...documentWrites, claimWrite],
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

export interface UpiDecisionInput {
  caseId: string;
  urgency: Urgency;
  transaction: Transaction;
  playbook: Playbook | null;
  paymentsPartner: string;
}

export function computeUpiDecision(input: UpiDecisionInput): Decision {
  const { transaction } = input;
  const txSource = { type: 'transaction' as const, ref: transaction.transaction_id, document: input.paymentsPartner };
  const facts: Fact[] = [
    { name: 'transaction_amount_inr', label: 'Debited amount', value: transaction.amount_inr, unit: 'INR', source: txSource, confidence: 0.99 },
    { name: 'counterparty', label: 'Paid to', value: `${transaction.counterparty}${transaction.counterparty_vpa ? ` (${transaction.counterparty_vpa})` : ''}`, source: txSource, confidence: 0.99 },
    { name: 'occurred_at', label: 'Time of debit', value: transaction.occurred_at, source: txSource, confidence: 0.99 },
    { name: 'device', label: 'Device', value: transaction.device, source: txSource, confidence: 0.9 },
    { name: 'first_time_counterparty', label: 'First payment to this counterparty', value: transaction.first_time_counterparty, source: txSource, confidence: 0.95 },
    {
      name: 'customer_confirmed_unfamiliar',
      label: 'You confirmed this payment is unfamiliar',
      value: true,
      source: { type: 'customer_statement', ref: 'Transaction confirmation in Saathi' },
      confidence: 1,
      confirmed_by_customer: true,
    },
  ];
  const signals = [
    !transaction.recognized_device && 'an unrecognized device',
    transaction.first_time_counterparty && 'a first-time counterparty',
    /T0[0-5]:/.test(transaction.occurred_at) && 'an unusual hour',
  ].filter(Boolean);

  const gate = confidenceGate(facts, { required: false });
  const drafts: OptionDraft[] = [
    {
      option_id: 'dispute_and_protect',
      title: 'Open a dispute + secure the account',
      summary: `Open a dispute for the ${formatInr(transaction.amount_inr)} debit to ${transaction.counterparty} and follow the protective checklist.`,
      steps: ['Approve the dispute with your Resolution Passport', 'Block UPI and change your UPI PIN in the app'],
      metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 0, effort_steps: 2, risk: 'low' },
      guardrails: [
        gate,
        { rule: 'Customer confirmed the payment is unfamiliar', passed: true, blocking: true, detail: 'You confirmed this debit in Saathi.' },
        { rule: 'Dispute amount matches the transaction', passed: true, blocking: true, detail: `${formatInr(transaction.amount_inr)} on ${transaction.transaction_id}.` },
      ],
      trade_offs: [
        'It registers the dispute immediately; prompt reporting can limit liability under bank rules.',
        'Resolution timing depends on the payment network and is simulated here.',
      ],
      writes: [
        {
          tool: 'payments.open_dispute',
          partner: input.paymentsPartner,
          amount_inr: transaction.amount_inr,
          summary: `Dispute the ${formatInr(transaction.amount_inr)} debit ${transaction.transaction_id}`,
          input: {
            case_id: input.caseId,
            transaction_id: transaction.transaction_id,
            amount_inr: transaction.amount_inr,
            reason: 'unauthorized_upi_debit',
          },
        },
      ],
      handoff: false,
      self_serve: false,
    },
    {
      option_id: 'contact_merchant_first',
      title: 'Contact the merchant first',
      summary: `Ask ${transaction.counterparty} for a refund before raising a dispute.`,
      steps: ['Contact the merchant for a refund', 'Raise a dispute if they do not respond'],
      metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 3, effort_steps: 2, risk: 'medium' },
      guardrails: [
        {
          rule: 'Fraud signals',
          passed: signals.length === 0,
          blocking: false,
          detail: signals.length ? `This debit shows ${signals.join(', ')}; contacting the counterparty first is risky.` : 'No fraud signals detected.',
        },
      ],
      trade_offs: ['It may work for a genuine merchant error, but it delays the official dispute.'],
      writes: [],
      handoff: false,
      self_serve: true,
    },
    {
      option_id: 'wait_and_monitor',
      title: 'Wait and monitor',
      summary: 'Do nothing now and watch for a reversal.',
      steps: [],
      metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 7, effort_steps: 0, risk: 'high' },
      guardrails: [
        { rule: 'Prompt reporting', passed: false, blocking: false, detail: 'Delaying the report can increase liability and reduce recovery chances.' },
      ],
      trade_offs: ['It needs no effort, but the account stays exposed.'],
      writes: [],
      handoff: false,
      self_serve: true,
    },
    humanSupportDraft(input.urgency),
  ];
  const options = rankOptions(drafts);
  return {
    formula_version: FORMULA_VERSION,
    computed_at: new Date().toISOString(),
    event_type: 'upi_dispute',
    calculation: null,
    facts,
    options,
    recommended_option_id: options.find((option) => option.recommended)?.option_id ?? null,
    explanation: explainOptions(options),
    warnings: signals.length ? [`Fraud signals: ${signals.join(', ')}.`] : [],
    requires_verification: !gate.passed,
    commission_considered: false,
    weights: { ...SCORE_WEIGHTS },
  };
}

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export interface EmiDecisionInput {
  caseId: string;
  urgency: Urgency;
  loan: LoanAccount;
  context: Omit<LoanContext, 'loans'>;
  profile: FinancialProfile;
  bridgeOffer: LenderOffer | null;
  rules: AffordabilityRules;
  lender: string;
  playbook: Playbook | null;
}

export function calculateEmiShortfall(input: { emi_inr: number; account_balance_inr: number; committed_before_due_inr: number }) {
  const values = [input.emi_inr, input.account_balance_inr, input.committed_before_due_inr];
  if (values.some((value) => !Number.isFinite(value) || value < 0)) throw new Error('EMI inputs must be non-negative numbers.');
  const availableBeforeDue = Math.max(input.account_balance_inr - input.committed_before_due_inr, 0);
  return {
    emi_inr: input.emi_inr,
    available_before_due_inr: availableBeforeDue,
    shortfall_inr: Math.max(input.emi_inr - availableBeforeDue, 0),
    formula: 'max(emi - max(account_balance - committed_before_due, 0), 0)',
  };
}

export function computeEmiDecision(input: EmiDecisionInput): Decision {
  const { loan, context, profile } = input;
  const shortfall = calculateEmiShortfall({
    emi_inr: loan.emi_inr,
    account_balance_inr: profile.account_balance_inr,
    committed_before_due_inr: context.committed_before_due_inr,
  });
  const gap = shortfall.shortfall_inr;
  const loanSource = { type: 'loan_account' as const, ref: loan.loan_id, document: input.lender };
  const salaryDelayDays = Math.max(daysBetween(loan.next_due_date, context.salary.expected_date), 0);
  const facts: Fact[] = [
    { name: 'emi_inr', label: `${loan.product} EMI`, value: loan.emi_inr, unit: 'INR', source: loanSource, confidence: 0.99 },
    { name: 'next_due_date', label: 'EMI due date', value: loan.next_due_date, source: loanSource, confidence: 0.99 },
    {
      name: 'account_balance_inr',
      label: 'Account balance',
      value: profile.account_balance_inr,
      unit: 'INR',
      source: { type: 'customer_profile', ref: profile.profile_id, document: profile.source },
      confidence: 0.95,
    },
    {
      name: 'committed_before_due_inr',
      label: 'Already committed before the due date',
      value: context.committed_before_due_inr,
      unit: 'INR',
      source: { type: 'customer_profile', ref: context.committed_note || 'Scheduled payments', document: profile.source },
      confidence: 0.9,
    },
    {
      name: 'salary_expected_date',
      label: `Salary expected (${context.salary.status})`,
      value: context.salary.expected_date,
      source: { type: 'salary_schedule', ref: context.salary.source },
      confidence: 0.8,
    },
    {
      name: 'shortfall_inr',
      label: 'EMI shortfall',
      value: gap,
      unit: 'INR',
      source: { type: 'calculation', ref: shortfall.formula },
      confidence: 0.95,
    },
  ];
  const gate = confidenceGate(facts, { required: false });

  if (gap === 0) {
    const options = rankOptions([
      {
        option_id: 'pay_on_time',
        title: 'Pay the EMI on time',
        summary: `Your available balance of ${formatInr(shortfall.available_before_due_inr)} covers the ${formatInr(loan.emi_inr)} EMI.`,
        steps: ['Keep the balance in your account until the due date'],
        metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 0, effort_steps: 0, risk: 'low' },
        guardrails: [{ rule: 'Balance covers the EMI', passed: true, blocking: true, detail: 'No shortfall this month.' }],
        trade_offs: ['Nothing to do; no new cost or credit.'],
        writes: [],
        handoff: false,
        self_serve: true,
      },
      humanSupportDraft(input.urgency),
    ]);
    return {
      formula_version: FORMULA_VERSION,
      computed_at: new Date().toISOString(),
      event_type: 'emi_shortfall',
      calculation: null,
      facts,
      options,
      recommended_option_id: options.find((option) => option.recommended)?.option_id ?? null,
      explanation: `There is no shortfall: ${formatInr(shortfall.available_before_due_inr)} is available for the ${formatInr(loan.emi_inr)} EMI.`,
      warnings: [],
      requires_verification: false,
      commission_considered: false,
      weights: { ...SCORE_WEIGHTS },
    };
  }

  const lateDays = salaryDelayDays;
  const bounceCost = loan.bounce_charge_inr + loan.late_fee_inr_per_day * lateDays;
  const requestedDate = addDays(context.salary.expected_date, 1);
  const shiftDays = daysBetween(loan.next_due_date, requestedDate);
  const drafts: OptionDraft[] = [
    {
      option_id: 'shift_due_date',
      title: 'Move the EMI date past payday',
      summary: `Ask the lender to move the ${formatInr(loan.emi_inr)} EMI from ${loan.next_due_date} to ${requestedDate}, the day after your salary arrives.`,
      steps: [`Approve the due-date request (${formatInr(loan.due_date_shift.fee_inr)} fee)`, 'Pay the EMI after your salary is credited'],
      metrics: { borrow_inr: 0, extra_cost_inr: loan.due_date_shift.fee_inr, monthly_emi_inr: 0, time_to_funds_days: 1, effort_steps: 1, risk: 'low' },
      guardrails: [
        gate,
        {
          rule: 'Lender allows a due-date change',
          passed: loan.due_date_shift.allowed,
          blocking: true,
          detail: loan.due_date_shift.allowed
            ? `Up to ${loan.due_date_shift.max_days} days for ${formatInr(loan.due_date_shift.fee_inr)}.`
            : 'This loan does not allow due-date changes.',
        },
        {
          rule: 'Salary arrives inside the allowed shift',
          passed: shiftDays <= loan.due_date_shift.max_days,
          blocking: true,
          detail: `Salary is expected ${salaryDelayDays} day(s) after the due date; the request needs ${shiftDays} of the ${loan.due_date_shift.max_days} allowed days.`,
        },
      ],
      trade_offs: ['No new credit and no bounce on your record.', 'Depends on the lender approving the request (simulated).'],
      writes: [
        {
          tool: 'lending.request_due_date_change',
          partner: input.lender,
          amount_inr: loan.due_date_shift.fee_inr,
          summary: `Move EMI on ${loan.loan_id} from ${loan.next_due_date} to ${requestedDate}`,
          input: {
            case_id: input.caseId,
            loan_id: loan.loan_id,
            current_due_date: loan.next_due_date,
            requested_due_date: requestedDate,
            fee_inr: loan.due_date_shift.fee_inr,
          },
        },
      ],
      handoff: false,
      self_serve: false,
    },
  ];

  const savingsAfter = profile.emergency_savings_inr - gap;
  const keepsBuffer = savingsAfter >= profile.minimum_emergency_buffer_inr;
  drafts.push({
    option_id: 'use_savings',
    title: `Cover the ${formatInr(gap)} from savings`,
    summary: `Move ${formatInr(gap)} from emergency savings to pay the EMI on time.`,
    steps: [`Transfer ${formatInr(gap)} from savings before ${loan.next_due_date}`],
    metrics: { borrow_inr: 0, extra_cost_inr: 0, monthly_emi_inr: 0, time_to_funds_days: 0, effort_steps: 1, risk: keepsBuffer ? 'low' : 'high' },
    guardrails: [
      {
        rule: 'Savings cover the shortfall',
        passed: profile.emergency_savings_inr >= gap,
        blocking: true,
        detail: `Emergency savings are ${formatInr(profile.emergency_savings_inr)}; the shortfall is ${formatInr(gap)}.`,
      },
      {
        rule: 'Emergency buffer protected',
        passed: keepsBuffer,
        blocking: false,
        detail: `Savings would fall to ${formatInr(Math.max(savingsAfter, 0))} against a ${formatInr(profile.minimum_emergency_buffer_inr)} buffer, in a month when salary is late.`,
      },
    ],
    trade_offs: ['No fees or credit.', keepsBuffer ? 'Your emergency buffer stays intact.' : 'It drains your emergency buffer while salary is delayed.'],
    writes: [],
    handoff: false,
    self_serve: true,
  });

  if (input.bridgeOffer && gap >= input.bridgeOffer.min_amount_inr && gap <= input.bridgeOffer.max_amount_inr) {
    const offer = input.bridgeOffer;
    const emi = calculateEmi(gap, offer.annual_rate_pct, offer.tenure_months);
    const fee = Math.round((gap * offer.processing_fee_pct) / 100);
    const affordability = checkAffordability(profile, emi.emi_inr, input.rules);
    drafts.push({
      option_id: 'bridge_loan',
      title: `Borrow only the ${formatInr(gap)} shortfall`,
      summary: `A ${offer.tenure_months}-month bridge of ${formatInr(gap)}, repaid as ${formatInr(emi.emi_inr)} after payday.`,
      steps: [`Approve the ${formatInr(gap)} bridge`, 'Pay the EMI on time', `Repay ${formatInr(emi.emi_inr)} next month`],
      metrics: {
        borrow_inr: gap,
        extra_cost_inr: emi.total_interest_inr + fee,
        monthly_emi_inr: emi.emi_inr,
        time_to_funds_days: offer.disbursal_days,
        effort_steps: 2,
        risk: 'medium',
      },
      guardrails: [
        gate,
        { rule: 'Affordability', passed: affordability.affordable, blocking: true, detail: affordability.detail },
        { rule: 'Exact-gap borrowing', passed: true, blocking: true, detail: `Borrows only the ${formatInr(gap)} shortfall, not the whole EMI.` },
      ],
      trade_offs: [`Costs ${formatInr(emi.total_interest_inr + fee)} in interest and fees.`, 'Adds a new credit line for one month.'],
      writes: [
        {
          tool: 'lending.submit_application',
          partner: input.lender,
          amount_inr: gap,
          summary: `Apply for a ${formatInr(gap)} ${offer.product}`,
          input: { case_id: input.caseId, offer_id: offer.offer_id, amount_inr: gap, tenure_months: offer.tenure_months, disburse_to: offer.disburse_to },
        },
      ],
      handoff: false,
      self_serve: false,
    });
  }

  drafts.push({
    option_id: 'let_it_bounce',
    title: 'Let the EMI bounce',
    summary: `Pay after salary arrives and accept the bounce charge and late fees.`,
    steps: [],
    metrics: { borrow_inr: 0, extra_cost_inr: bounceCost, monthly_emi_inr: 0, time_to_funds_days: 0, effort_steps: 0, risk: 'high' },
    guardrails: [
      {
        rule: 'Credit record protected',
        passed: false,
        blocking: false,
        detail: `A bounce costs about ${formatInr(bounceCost)} (${formatInr(loan.bounce_charge_inr)} charge + ${lateDays} day(s) late fee) and can be reported to credit bureaus.`,
      },
    ],
    trade_offs: ['No action now, but the most expensive path with credit-record risk.'],
    writes: [],
    handoff: false,
    self_serve: true,
  });
  // A specialist callback does not fund the EMI, so waiting is time-critical before the due date.
  drafts.push(humanSupportDraft('high', `The EMI is due ${loan.next_due_date}; the shortfall stays open until a specialist responds.`));

  const options = rankOptions(drafts);
  return {
    formula_version: FORMULA_VERSION,
    computed_at: new Date().toISOString(),
    event_type: 'emi_shortfall',
    calculation: null,
    facts,
    options,
    recommended_option_id: options.find((option) => option.recommended)?.option_id ?? null,
    explanation: `EMI ${formatInr(loan.emi_inr)} - ${formatInr(shortfall.available_before_due_inr)} available before ${loan.next_due_date} = ${formatInr(gap)} shortfall. ${explainOptions(options)}`,
    warnings: context.salary.status === 'delayed' ? [`Salary is delayed to ${context.salary.expected_date}.`] : [],
    requires_verification: !gate.passed,
    commission_considered: false,
    weights: { ...SCORE_WEIGHTS },
  };
}

export function computeHumanOnlyDecision(input: { eventType: EventType; urgency: Urgency; playbook: Playbook | null }): Decision {
  const reason = input.playbook
    ? `The "${input.playbook.title}" journey is not automated in this demo, so a specialist continues from your passport.`
    : 'This situation has no automated playbook in the demo, so a specialist continues from your passport.';
  const options = rankOptions([humanSupportDraft(input.urgency, reason)]);
  return {
    formula_version: FORMULA_VERSION,
    computed_at: new Date().toISOString(),
    event_type: input.eventType,
    calculation: null,
    facts: [],
    options,
    recommended_option_id: 'human_support',
    explanation: reason,
    warnings: [],
    requires_verification: false,
    commission_considered: false,
    weights: { ...SCORE_WEIGHTS },
  };
}

const HOSPITAL_TERMS = ['hospital', 'hospitalized', 'hospitalised', 'admitted', 'surgery', 'icu', 'discharge', 'अस्पताल', 'हॉस्पिटल', 'भर्ती', 'ऑपरेशन'];
const UPI_TERMS = ['upi', 'unrecognized', 'unrecognised', 'not mine', 'fraud', 'scam', 'nahi kiya', "didn't make", 'did not make', 'unknown transaction', 'यूपीआई', 'धोखा', 'फ्रॉड', 'नहीं किया'];
const EMI_TERMS = ['emi', 'salary delayed', 'loan payment', 'installment', 'instalment', 'ईएमआई', 'किस्त', 'सैलरी'];
const FAMILY_TERMS = ['papa', 'father', 'mother', 'mummy', 'पापा', 'पिताजी', 'माँ', 'मम्मी'];

// Triggers now live in the playbook YAML files; the term lists below are kept for reference only.
export function classifyEvent(message: string): { event_type: EventType; urgency: Urgency } {
  const { event_type, urgency } = classifyWithPlaybooks(message);
  return { event_type, urgency };
}

export function legacyClassifyEvent(message: string): { event_type: EventType; urgency: Urgency } {
  const normalized = message.toLowerCase();
  const has = (terms: string[]) => terms.some((term) => normalized.includes(term));
  if (has(HOSPITAL_TERMS)) return { event_type: 'hospitalization', urgency: 'high' };
  if (has(UPI_TERMS)) return { event_type: 'upi_dispute', urgency: 'high' };
  if (has(EMI_TERMS)) return { event_type: 'emi_shortfall', urgency: 'medium' };
  if (has(FAMILY_TERMS)) return { event_type: 'hospitalization', urgency: 'high' };
  return { event_type: 'general_financial_support', urgency: 'low' };
}

export function parseStatedAmount(message: string): number | null {
  const match =
    /(?:₹|\binr\b|\brs\.?)\s*([0-9][0-9,]*)/i.exec(message) ?? /\b([0-9][0-9,]{2,})\s*(?:₹|inr|rs\b|rupees|rupaye|रुपये|रुपए|रु)/i.exec(message);
  if (!match) return null;
  const value = Number(match[1]!.replace(/,/g, ''));
  return Number.isFinite(value) && value > 0 ? value : null;
}
