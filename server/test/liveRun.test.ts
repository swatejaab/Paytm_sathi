import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { api, bearer, login, waitFor } from './helpers';

describe('live agent runs', () => {
  it('returns at once and finishes the plan in the background, step by step', async () => {
    const token = await login();
    const response = await api()
      .post('/api/cases/intake')
      .set(bearer(token))
      .send({ message: 'Hospital bill is INR 80,000, what should I do?', consent_to_read_case_data: true, stream: true });
    assert.equal(response.status, 202);
    assert.equal(response.body.agent_runs.at(-1).outcome, 'running');

    const done = await waitFor(async () => {
      const record = (await api().get(`/api/cases/${response.body.case_id}`).set(bearer(token))).body;
      return record.agent_runs.at(-1).outcome !== 'running' && record.decision ? record : null;
    }, 8000);
    assert.equal(done.decision.calculation.bill_total_inr, 80000);
    assert.ok(done.agent_runs.at(-1).steps.length >= 5);
  });
});
