import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { api, bearer, createCase, login } from './helpers';

describe('hospital plan from the customer’s own numbers', () => {
  it('asks for the bill instead of assuming one, then plans from the reply', async () => {
    const token = await login();
    const record = await createCase(token, 'i have a medical emergancy what should i do');
    assert.equal(record.event_type, 'hospitalization');
    assert.equal(record.decision, null);
    assert.match(record.messages.at(-1)!.content, /tell me the bill or estimate amount/);

    const response = await api()
      .post(`/api/cases/${record.case_id}/chat`)
      .set(bearer(token))
      .send({ message: 'bill is 1.2 lakh and I can pay 25000', confirm_external_processing: true });
    assert.equal(response.status, 200);
    const calculation = response.body.decision.calculation;
    assert.equal(calculation.bill_total_inr, 120000);
    assert.equal(calculation.customer_contribution_inr, 25000);

    const followUp = await api()
      .post(`/api/cases/${record.case_id}/chat`)
      .set(bearer(token))
      .send({ message: 'he will stay 4 days', confirm_external_processing: true });
    assert.equal(followUp.status, 200);
    assert.notEqual(followUp.body.decision.calculation.exact_gap_inr, calculation.exact_gap_inr);
  });
});
