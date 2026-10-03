import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessCoverage, categorize, roomDays } from '../src/coverage';
import { healthRecordsFor } from '../src/fixtures';
import { api, bearer, chat, createCase, login } from './helpers';

const neha = healthRecordsFor('demo-customer-01');
const schedule = neha.policy!.schedule;

describe('coverage rules engine', () => {
  it("derives Neha's INR 55,000 cashless estimate line by line (bill lines 4-9)", () => {
    const result = assessCoverage(neha.admission!.bill.lines, schedule);
    assert.deepEqual(
      result.lines.map((line) => [line.line, line.status, line.payable_inr, line.clause_id]),
      [
        [4, 'capped', 15000, '3.2'],
        [5, 'payable', 6000, '3.1'],
        [6, 'payable', 10000, '3.1'],
        [7, 'payable', 19000, '3.1'],
        [8, 'payable', 10000, '3.1'],
        [9, 'excluded', 0, '4.3'],
      ],
    );
    assert.equal(result.payable_before_deductible_inr, 60000);
    assert.equal(result.deductible_inr, 5000);
    assert.equal(result.estimated_coverage_inr, 55000);
    assert.equal(result.not_covered_inr, 25000);
    assert.deepEqual(result.assumptions, []);
  });

  it("uses each customer's own policy schedule", () => {
    const arjun = healthRecordsFor('demo-customer-02');
    const result = assessCoverage(arjun.admission!.bill.lines, arjun.policy!.schedule);
    assert.equal(result.lines[0]!.status, 'payable', 'two days within the INR 10,000 daily room limit');
    assert.equal(result.estimated_coverage_inr, 107000);
    assert.equal(healthRecordsFor('demo-customer-03').admission, null);
    assert.deepEqual(healthRecordsFor('unknown-customer'), { policy: null, admission: null });
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

  it('estimates cover for an uploaded itemised bill when no hospital record exists', async () => {
    const token = await login('demo-customer-03', '8642');
    const record = await createCase(token, 'Papa hospital mein hain, insurance hai. Bill upload karta hoon.');
    assert.equal(record.context?.awaiting, 'bill_inr');
    assert.match(record.assistant_message, /couldn't find a hospital admission|koi hospital admission nahi mila/i);
    const billText = [
      'City Care Hospital - Final bill',
      'Room and nursing (3 days): 30000',
      'Diagnostics: 10000',
      'Procedure: 25000',
      'Pharmacy and supplies: 15000',
      'Grand total: 80,000',
    ].join('\n');
    const upload = await api()
      .post(`/api/cases/${record.case_id}/documents`)
      .set(bearer(token))
      .field('document_type', 'bill')
      .attach('file', Buffer.from(billText), { filename: 'final-bill.txt', contentType: 'text/plain' });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    const confirmed = await api()
      .post(`/api/cases/${record.case_id}/bill-confirmation`)
      .set(bearer(token))
      .send({ document_id: upload.body.document_id, confirmed: true });
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
    // Riya's balance is already committed before salary, so the records say she can pay nothing now.
    assert.equal(confirmed.body.decision.calculation.customer_contribution_inr, 0);
    assert.equal(confirmed.body.decision.calculation.exact_gap_inr, 20000);

    const planned = await chat(token, 'I can pay ₹10,000', record.case_id);
    assert.equal(planned.decision?.calculation?.bill_total_inr, 80000);
    // The uploaded bill does not itemise non-medical consumables, so the estimate says so instead of deducting them.
    assert.equal(planned.decision?.calculation?.coverage_estimate_inr, 60000);
    assert.equal(planned.decision?.calculation?.exact_gap_inr, 10000);
    assert.equal(planned.decision?.coverage_breakdown?.lines.length, 4);
    assert.ok(planned.decision?.coverage_breakdown?.assumptions.some((note) => /not itemised/.test(note)));
    const evidence = await api().get(`/api/cases/${record.case_id}/evidence`).set(bearer(token));
    assert.ok(evidence.body.retrieved_evidence.some((clause: { clause_id?: string }) => clause.clause_id === '3.1'));
  });
});
