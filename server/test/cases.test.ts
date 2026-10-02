import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { CaseRecord } from '../src/types';
import { api, bearer, createCase, HOSPITAL_MESSAGE, login, UPI_MESSAGE } from './helpers';

describe('authentication and authorization', () => {
  test('rejects wrong passcodes and unauthenticated requests', async () => {
    const wrong = await api().post('/api/auth/login').send({ user_id: 'demo-customer-01', passcode: '0000' });
    assert.equal(wrong.status, 401);
    const anonymous = await api().post('/api/cases/intake').send({ message: HOSPITAL_MESSAGE });
    assert.equal(anonymous.status, 401);
    const forged = await api().get('/api/cases').set(bearer('not-a-real-token'));
    assert.equal(forged.status, 401);
  });

  test('customers cannot read each other\'s cases; support can read but not approve', async () => {
    const owner = await login();
    const other = await login('demo-customer-02', '1357');
    const support = await login('support-agent-01', '9999');
    const record = await createCase(owner);

    assert.equal((await api().get(`/api/cases/${record.case_id}`).set(bearer(other))).status, 404);
    assert.equal((await api().get(`/api/cases/${record.case_id}`).set(bearer(support))).status, 200);
    const supportPrepare = await api()
      .post(`/api/cases/${record.case_id}/actions`)
      .set(bearer(support))
      .send({ option_id: 'claim_plus_gap_plan' });
    assert.equal(supportPrepare.status, 403);
    const queue = await api().get('/api/support/cases').set(bearer(support));
    assert.equal(queue.status, 200);
    assert.ok(queue.body.cases.some((item: { case_id: string }) => item.case_id === record.case_id));
  });

  test('customer_id cannot be supplied by the client', async () => {
    const token = await login();
    const response = await api()
      .post('/api/cases/intake')
      .set(bearer(token))
      .send({ message: HOSPITAL_MESSAGE, customer_id: 'demo-customer-02' });
    assert.equal(response.status, 422);
  });
});

describe('case intake and workflow', () => {
  test('hospital intake persists the case and calculates the exact gap', async () => {
    const token = await login();
    const record = await createCase(token, 'Papa is in hospital. The bill is INR 80,000. What should I do?');
    assert.equal(record.event_type, 'hospitalization');
    assert.equal(record.status, 'options_ready');
    assert.equal(record.decision?.calculation?.exact_gap_inr, 15000);
    assert.equal(record.decision?.recommended_option_id, 'claim_plus_gap_plan');
    assert.deepEqual(
      record.timeline.map((entry) => entry.status).filter((status, index, all) => all.indexOf(status) === index),
      ['intake', 'understand', 'evidence_ready', 'options_ready'],
    );
    const saved = await api().get(`/api/cases/${record.case_id}`).set(bearer(token));
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body, record);
  });

  test('without consent the case waits at intake and reads nothing', async () => {
    const token = await login();
    const record = await createCase(token, HOSPITAL_MESSAGE, false);
    assert.equal(record.status, 'intake');
    assert.equal(record.decision, null);
    const audit = await api().get(`/api/cases/${record.case_id}/audit`).set(bearer(token));
    assert.ok(!audit.body.events.some((event: { event: string }) => event.event === 'mcp_tool_call'));

    const granted = await api()
      .post(`/api/cases/${record.case_id}/consents`)
      .set(bearer(token))
      .send({ purpose: 'prepare_resolution_options', granted: true });
    assert.equal(granted.body.status, 'options_ready');

    const revoked = await api()
      .post(`/api/cases/${record.case_id}/consents`)
      .set(bearer(token))
      .send({ purpose: 'prepare_resolution_options', granted: false });
    assert.equal(revoked.body.status, 'intake');
    const prepare = await api()
      .post(`/api/cases/${record.case_id}/actions`)
      .set(bearer(token))
      .send({ option_id: 'claim_plus_gap_plan' });
    assert.equal(prepare.status, 409);
  });

  test('general intake does not attach hospital facts', async () => {
    const token = await login();
    const record = await createCase(token, 'I want help understanding my monthly money.');
    assert.equal(record.event_type, 'general_financial_support');
    assert.equal(record.decision?.calculation, null);
    assert.equal(record.decision?.recommended_option_id, 'human_support');
    const evidence = await api().get(`/api/cases/${record.case_id}/evidence`).set(bearer(token));
    assert.deepEqual(evidence.body.documents, []);
    assert.equal(evidence.body.calculation, null);
  });

  test('intake rejects messages that are too short', async () => {
    const token = await login();
    const response = await api().post('/api/cases/intake').set(bearer(token)).send({ message: 'Help' });
    assert.equal(response.status, 422);
  });

  test('UPI journey asks for the transaction, then recommends a dispute', async () => {
    const token = await login();
    const record = await createCase(token, UPI_MESSAGE);
    assert.equal(record.event_type, 'upi_dispute');
    assert.equal(record.status, 'understand');
    const candidates = record.pending_question?.candidates ?? [];
    assert.equal(candidates.length, 2);
    assert.ok(candidates.every((candidate) => candidate.amount_inr === 8500));

    const confirmed = await api()
      .post(`/api/cases/${record.case_id}/transaction-confirmation`)
      .set(bearer(token))
      .send({ transaction_id: 'TXN-UPI-20261002-0214', recognized: false });
    assert.equal(confirmed.status, 200);
    const updated = confirmed.body as CaseRecord;
    assert.equal(updated.status, 'options_ready');
    assert.equal(updated.decision?.recommended_option_id, 'dispute_and_protect');
    assert.equal(updated.evidence?.transaction?.counterparty, 'QuickKart Digital Services');
  });

  test('UPI journey closes without a dispute when the customer recognizes the payment', async () => {
    const token = await login();
    const record = await createCase(token, UPI_MESSAGE);
    const confirmed = await api()
      .post(`/api/cases/${record.case_id}/transaction-confirmation`)
      .set(bearer(token))
      .send({ transaction_id: 'TXN-UPI-20260928-1840', recognized: true });
    assert.equal(confirmed.body.status, 'resolved');
    assert.equal(confirmed.body.actions.length, 0);
  });

  test('passport reuses the same facts and sources', async () => {
    const token = await login();
    const record = await createCase(token);
    const passport = await api().get(`/api/cases/${record.case_id}/passport`).set(bearer(token));
    assert.equal(passport.status, 200);
    assert.equal(passport.body.calculation.exact_gap_inr, 15000);
    assert.ok(passport.body.evidence_sources.some((source: { clause_id?: string }) => source.clause_id === '3.1'));
  });

  test('human handoff routes the case to the support queue', async () => {
    const token = await login();
    const record = await createCase(token);
    const response = await api().post(`/api/cases/${record.case_id}/handoff`).set(bearer(token)).send({});
    assert.equal(response.body.status, 'human_review');
  });
});
