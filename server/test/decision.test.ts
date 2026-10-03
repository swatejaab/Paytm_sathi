import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { calculateEmi, calculateExactGap, checkAffordability, classifyEvent, parseStatedAmount } from '../src/decision';
import { fixtures, offersFor } from '../src/fixtures';
import { computeHospitalDecision, type HospitalDecisionInput } from '../src/hospitalDecision';

const said = (ref: string) => ({ type: 'customer_statement' as const, ref });

function hospitalInput(
  customerId = 'demo-customer-01',
  amounts: { bill: number; cover: number | null; pay: number } = { bill: 80000, cover: 55000, pay: 10000 },
  overrides: Partial<HospitalDecisionInput> = {},
): HospitalDecisionInput {
  return {
    caseId: 'SA-TEST0001',
    urgency: 'high',
    bill: { value: amounts.bill, source: said('bill'), confidence: 0.9, lines: null, document_id: null, file_name: null },
    insurance:
      amounts.cover === null
        ? null
        : { value: amounts.cover, source: said('cover'), confidence: 0.8, policy_document_id: null, policy_file_name: null, assumptions: [] },
    contribution: { value: amounts.pay, source: said('pay'), confidence: 1, confirmed_by_customer: true },
    profile: fixtures.profiles[customerId]!,
    offers: offersFor(customerId),
    rules: fixtures.lending.affordability_rules,
    partners: { insurer: 'insurer', lender: 'lender', hospital: 'hospital' },
    statedBillInr: null,
    verification: { required: false },
    ...overrides,
  };
}

describe('deterministic decision service', () => {
  test('funding gap is max(bill - insurance - what you can pay, 0)', () => {
    const calculation = calculateExactGap({
      bill_total_inr: 500000,
      bill_line_total_inr: 500000,
      coverage_estimate_inr: 300000,
      customer_contribution_inr: 50000,
    });
    assert.equal(calculation.exact_gap_inr, 150000);
    assert.equal(
      calculateExactGap({ bill_total_inr: 100000, bill_line_total_inr: 100000, coverage_estimate_inr: 90000, customer_contribution_inr: 20000 })
        .exact_gap_inr,
      0,
    );
  });

  test('exact gap rejects bills that do not reconcile or exceed bounds', () => {
    assert.throws(() =>
      calculateExactGap({ bill_total_inr: 80000, bill_line_total_inr: 79000, coverage_estimate_inr: 1, customer_contribution_inr: 1 }),
    );
    assert.throws(() =>
      calculateExactGap({ bill_total_inr: 1000, bill_line_total_inr: 1000, coverage_estimate_inr: 2000, customer_contribution_inr: 0 }),
    );
  });

  test('EMI uses the standard amortization formula', () => {
    assert.deepEqual(calculateEmi(15000, 14, 3), { emi_inr: 5117, total_interest_inr: 351 });
    assert.deepEqual(calculateEmi(80000, 18, 12), { emi_inr: 7334, total_interest_inr: 8008 });
    assert.deepEqual(calculateEmi(12000, 0, 12), { emi_inr: 1000, total_interest_inr: 0 });
  });

  test('affordability guardrail blocks EMIs beyond the safe limit', () => {
    const profile = fixtures.profiles['demo-customer-03']!;
    assert.equal(checkAffordability(profile, 5117, fixtures.lending.affordability_rules).affordable, true);
    assert.equal(checkAffordability(profile, 20000, fixtures.lending.affordability_rules).affordable, false);
  });

  test('uses the amounts the customer gave, not any preset bill', () => {
    const decision = computeHospitalDecision(hospitalInput('demo-customer-02', { bill: 500000, cover: 300000, pay: 50000 }));
    assert.equal(decision.calculation?.bill_total_inr, 500000);
    assert.equal(decision.calculation?.coverage_estimate_inr, 300000);
    assert.equal(decision.calculation?.customer_contribution_inr, 50000);
    assert.equal(decision.calculation?.exact_gap_inr, 150000);
    const plan = decision.options.find((option) => option.option_id === 'claim_plus_gap_plan')!;
    assert.equal(plan.metrics.borrow_inr, 150000);
    const values = JSON.stringify(decision);
    for (const preset of ['80,000', '55,000']) assert.ok(!values.includes(preset), `found ${preset}`);
  });

  test('recommends the exact-gap plan when savings would breach the buffer', () => {
    const decision = computeHospitalDecision(hospitalInput());
    assert.equal(decision.calculation?.exact_gap_inr, 15000);
    assert.equal(decision.recommended_option_id, 'claim_plus_gap_plan');
    assert.equal(decision.commission_considered, false);
    const savings = decision.options.find((option) => option.option_id === 'claim_plus_savings')!;
    assert.equal(savings.metrics.risk, 'high');
    assert.equal(savings.guardrails.find((guardrail) => guardrail.rule === 'Keep the emergency buffer')?.passed, false);
    const loan = decision.options.find((option) => option.option_id === 'full_bill_loan')!;
    assert.ok(loan.scores.total < decision.options[0]!.scores.total);
  });

  test("Neha's plan: claim + ₹15,000 plan beats savings, redeeming funds, the full loan and waiting", () => {
    const decision = computeHospitalDecision(
      hospitalInput('demo-customer-01', undefined, {
        offers: offersFor('demo-customer-01'),
        missingDocuments: ['Discharge summary'],
        mutualFunds: [
          { name: 'Flexi-cap mutual funds', value_inr: 346000 },
          { name: 'Nifty 50 index fund', value_inr: 152000 },
        ],
      }),
    );
    const byId = Object.fromEntries(decision.options.map((option) => [option.option_id, option]));
    assert.equal(decision.recommended_option_id, 'claim_plus_gap_plan');
    assert.equal(byId.claim_plus_gap_plan!.trade_offs[0], '₹65,000 less borrowed than a full loan for the bill.');
    assert.equal(byId.claim_plus_savings!.metrics.risk, 'high', 'savings would break the safety buffer');
    assert.ok(byId.full_bill_loan!.summary.includes('pre-approved personal loan'));
    const redeem = byId.claim_plus_redeem!;
    assert.ok(redeem.feasible);
    assert.equal(redeem.guardrails.find((guardrail) => guardrail.rule === 'Money arrives in time')?.passed, false);
    assert.ok(redeem.steps.at(-1)!.includes('Flexi-cap mutual funds'));
    for (const id of ['claim_plus_redeem', 'claim_plus_savings', 'full_bill_loan', 'wait_for_claim']) {
      assert.ok(byId[id]!.scores.total < byId.claim_plus_gap_plan!.scores.total, id);
    }
    const writes = byId.claim_plus_gap_plan!.writes;
    assert.deepEqual(writes.find((write) => write.tool === 'claim.submit')?.input.pending_documents, ['Discharge summary']);
    assert.equal(writes.find((write) => write.tool === 'hospital.request_document')?.input.document, 'Discharge summary');
    assert.ok(decision.warnings.some((warning) => /discharge summary/.test(warning)));
  });

  test('pre-approved offers are only shown to the customer they were made to', () => {
    assert.ok(offersFor('demo-customer-01').some((offer) => offer.offer_id === 'OFFER-PA-PL-12M'));
    assert.ok(!offersFor('demo-customer-02').some((offer) => offer.offer_id === 'OFFER-PA-PL-12M'));
  });

  test('stays product-neutral: recommends savings when the buffer survives', () => {
    const decision = computeHospitalDecision(hospitalInput('demo-customer-02'));
    assert.equal(decision.recommended_option_id, 'claim_plus_savings');
  });

  test('without insurance there is no claim step and the gap uses the bill and payment only', () => {
    const decision = computeHospitalDecision(hospitalInput('demo-customer-02', { bill: 200000, cover: null, pay: 20000 }));
    assert.equal(decision.calculation?.exact_gap_inr, 180000);
    assert.ok(decision.options.every((option) => option.writes.every((write) => write.tool !== 'claim.submit')));
    assert.ok(decision.options.some((option) => option.option_id === 'hospital_instalments'));
  });

  test('cover larger than the bill is capped with a warning', () => {
    const decision = computeHospitalDecision(hospitalInput('demo-customer-02', { bill: 100000, cover: 150000, pay: 0 }));
    assert.equal(decision.calculation?.coverage_estimate_inr, 100000);
    assert.equal(decision.calculation?.exact_gap_inr, 0);
    assert.ok(decision.warnings.some((warning) => warning.includes('more than the bill')));
  });

  test('confidence gate routes uploaded-document cases to a specialist', () => {
    const decision = computeHospitalDecision(hospitalInput('demo-customer-01', undefined, { verification: { required: true, reason: 'verify uploads' } }));
    assert.equal(decision.requires_verification, true);
    assert.equal(decision.recommended_option_id, 'human_support');
    assert.ok(decision.options.filter((option) => option.writes.length && !option.handoff).every((option) => !option.feasible));
  });

  test('every displayed fact carries a source', () => {
    const decision = computeHospitalDecision(hospitalInput());
    assert.ok(decision.facts.every((fact) => fact.source.type && fact.source.ref));
  });

  test('classifies events and parses stated amounts', () => {
    assert.equal(classifyEvent('Papa is in hospital').event_type, 'hospitalization');
    assert.equal(classifyEvent('Unrecognized UPI debit, not mine').event_type, 'upi_dispute');
    assert.equal(classifyEvent('Salary delayed, EMI due').event_type, 'emi_shortfall');
    assert.equal(classifyEvent('Help me plan my monthly money').event_type, 'general_financial_support');
    assert.equal(classifyEvent('I have a particular question').event_type, 'general_financial_support');
    assert.equal(parseStatedAmount('Bill INR 80,000 hai'), 80000);
    assert.equal(parseStatedAmount('₹8,500 gaya'), 8500);
    assert.equal(parseStatedAmount('my bill is 5 lakh'), 500000);
    assert.equal(parseStatedAmount('no amount here'), null);
  });
});
