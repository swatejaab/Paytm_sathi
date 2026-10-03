import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessCoverage, categorize, roomDays } from '../src/coverage';
import { fixtures } from '../src/fixtures';
import { api, bearer, createCase, login } from './helpers';

const schedule = fixtures.documents.policy.schedule;

describe('coverage rules engine', () => {
  it('derives the INR 55,000 hero estimate line by line', () => {
    const result = assessCoverage(fixtures.documents.bill.lines, schedule);
    assert.deepEqual(
      result.lines.map((line) => [line.line, line.status, line.payable_inr, line.clause_id]),
      [
        [4, 'capped', 15000, '3.2'],
        [5, 'payable', 10000, '3.1'],
        [6, 'payable', 25000, '3.1'],
        [7, 'partly_excluded', 10000, '4.3'],
      ],
    );
    assert.equal(result.payable_before_deductible_inr, 60000);
    assert.equal(result.deductible_inr, 5000);
    assert.equal(result.estimated_coverage_inr, 55000);
    assert.equal(result.not_covered_inr, 25000);
  });

  it('reads room days from the description and flags what it cannot see', () => {
    assert.equal(roomDays({ line: 1, description: 'Room charges (3 days)', amount_inr: 36000 }), 3);
    assert.equal(roomDays({ line: 1, description: 'Ward x 2 nights', amount_inr: 8000 }), 2);
    assert.equal(categorize('Medicines & consumables'), 'pharmacy');
    assert.equal(categorize('Doctor visits'), 'medical');

    const result = assessCoverage(
      [
        { line: 1, description: 'Room charges (3 days)', amount_inr: 36000 },
        { line: 2, description: 'Doctor visits', amount_inr: 12500 },
        { line: 3, description: 'Medicines & consumables', amount_inr: 18250 },
        { line: 4, description: 'Lab tests', amount_inr: 8250 },
      ],
      schedule,
    );
    assert.equal(result.lines[0]!.payable_inr, 15000);
    assert.equal(result.estimated_coverage_inr, 15000 + 12500 + 18250 + 8250 - 5000);
    assert.ok(result.assumptions.some((note) => /not itemised/.test(note)));
  });

  it('never pays beyond the sum insured', () => {
    const result = assessCoverage([{ line: 1, description: 'Procedure', amount_inr: 900000 }], schedule);
    assert.equal(result.estimated_coverage_inr, schedule.sum_insured_inr);
  });

  it('feeds the hospital decision and keeps the breakdown with it', async () => {
    const token = await login();
    const record = await createCase(token);
    assert.equal(record.decision?.calculation?.coverage_estimate_inr, 55000);
    assert.equal(record.decision?.calculation?.exact_gap_inr, 15000);
    assert.equal(record.decision?.coverage_breakdown?.lines.length, 4);
    const evidence = await api().get(`/api/cases/${record.case_id}/evidence`).set(bearer(token));
    assert.ok(evidence.body.retrieved_evidence.some((clause: { clause_id?: string }) => clause.clause_id === '3.1'));
  });
});
