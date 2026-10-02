import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
  calculateEmi,
  calculateExactGap,
  checkAffordability,
  classifyEvent,
  computeHospitalDecision,
  parseStatedAmount,
  type HospitalDecisionInput,
} from '../src/decision';
import { fixtures } from '../src/fixtures';

function hospitalInput(customerId = 'demo-customer-01', overrides: Partial<HospitalDecisionInput> = {}): HospitalDecisionInput {
  const { bill, policy } = fixtures.documents;
  return {
    caseId: 'SA-TEST0001',
    urgency: 'high',
    bill,
    coverage: {
      estimated_coverage_inr: policy.estimated_coverage_inr,
      clause_id: '3.1',
      page: 4,
      confidence: policy.coverage_confidence,
      policy_document_id: policy.document_id,
      policy_file_name: policy.file_name,
    },
    assumptions: [{ clause_id: '3.2', page: 4, title: 'Room category limit' }],
    claimChecklist: { clause_id: '5.4', page: 9, missing: fixtures.documents.missing_documents },
    profile: fixtures.profiles[customerId]!,
    offers: fixtures.lending.offers,
    rules: fixtures.lending.affordability_rules,
    partners: { insurer: 'insurer', lender: 'lender', hospital: 'hospital' },
    statedAmountInr: 80000,
    verification: { required: false },
    ...overrides,
  };
}

describe('deterministic decision service', () => {
  test('exact gap matches the fixture expectation', () => {
    const calculation = calculateExactGap({
      bill_total_inr: 80000,
      bill_line_total_inr: 80000,
      coverage_estimate_inr: 55000,
      customer_contribution_inr: 10000,
    });
    assert.equal(calculation.exact_gap_inr, fixtures.documents.expected_calculation.exact_gap_inr);
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
    const profile = fixtures.profiles['demo-customer-01']!;
    assert.equal(checkAffordability(profile, 5117, fixtures.lending.affordability_rules).affordable, true);
    assert.equal(checkAffordability(profile, 20000, fixtures.lending.affordability_rules).affordable, false);
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

  test('stays product-neutral: recommends savings when the buffer survives', () => {
    const decision = computeHospitalDecision(hospitalInput('demo-customer-02'));
    assert.equal(decision.recommended_option_id, 'claim_plus_savings');
  });

  test('confidence gate routes uploaded-document cases to a specialist', () => {
    const decision = computeHospitalDecision(hospitalInput('demo-customer-01', { verification: { required: true, reason: 'verify uploads' } }));
    assert.equal(decision.requires_verification, true);
    assert.equal(decision.recommended_option_id, 'human_support');
    assert.ok(decision.options.filter((option) => option.writes.length).every((option) => !option.feasible));
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
    assert.equal(parseStatedAmount('Bill INR 80,000 hai'), 80000);
    assert.equal(parseStatedAmount('₹8,500 gaya'), 8500);
    assert.equal(parseStatedAmount('no amount here'), null);
  });
});
