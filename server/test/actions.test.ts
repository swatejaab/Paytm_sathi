import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { signApprovalToken } from '../src/auth';
import { findCase } from '../src/db';
import { hmacSha256Hex } from '../src/hashing';
import { GatewayError } from '../src/mcp/errors';
import { invokeTool } from '../src/mcp/gateway';
import type { CaseRecord } from '../src/types';
import { api, bearer, createCase, login, UPI_MESSAGE, waitFor } from './helpers';

async function prepare(token: string, caseId: string, optionId: string): Promise<CaseRecord> {
  const response = await api().post(`/api/cases/${caseId}/actions`).set(bearer(token)).send({ option_id: optionId });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body as CaseRecord;
}

const customer = { sub: 'demo-customer-01', role: 'customer' as const, display_name: 'Neha', scopes: ['case:read'] };

describe('approval-bound actions', () => {
  test('approving the exact payload submits steps and the simulated partner resolves the case', async () => {
    const token = await login();
    const record = await createCase(token);
    const prepared = await prepare(token, record.case_id, 'claim_plus_gap_plan');
    assert.equal(prepared.status, 'awaiting_approval');
    const action = prepared.actions.at(-1)!;
    assert.deepEqual(
      action.payload.steps.map((step) => step.tool),
      ['claim.submit', 'hospital.request_document', 'payments.create_link', 'lending.submit_application'],
    );
    assert.equal(action.payload.steps.find((step) => step.tool === 'payments.create_link')?.amount_inr, 10000);
    assert.equal(action.payload.steps.find((step) => step.tool === 'lending.submit_application')?.amount_inr, 15000);

    const wrongHash = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: 'f'.repeat(64), confirm: true });
    assert.equal(wrongHash.status, 409);

    const approved = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.status, 'in_progress');
    assert.equal(approved.body.actions.at(-1).partner_requests.length, 4);

    const resolved = await waitFor(async () => {
      const current = findCase(record.case_id);
      return current?.status === 'resolved' ? current : null;
    });
    assert.ok(resolved.actions.at(-1)!.partner_requests.every((request) => request.status === 'completed'));

    const again = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    assert.equal(again.status, 409);
  });

  test('another customer cannot approve the action', async () => {
    const owner = await login();
    const other = await login('demo-customer-02', '1357');
    const record = await createCase(owner);
    const action = (await prepare(owner, record.case_id, 'claim_plus_gap_plan')).actions.at(-1)!;
    const response = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(other))
      .send({ payload_hash: action.payload_hash, confirm: true });
    assert.equal(response.status, 404);
  });

  test('guardrail-blocked and self-serve options cannot be prepared', async () => {
    const token = await login();
    const record = await createCase(token, UPI_MESSAGE);
    await api()
      .post(`/api/cases/${record.case_id}/transaction-confirmation`)
      .set(bearer(token))
      .send({ transaction_id: 'TXN-UPI-20261002-0214', recognized: false });
    const selfServe = await api()
      .post(`/api/cases/${record.case_id}/actions`)
      .set(bearer(token))
      .send({ option_id: 'wait_and_monitor' });
    assert.equal(selfServe.status, 422);

    const prepared = await prepare(token, record.case_id, 'dispute_and_protect');
    const action = prepared.actions.at(-1)!;
    assert.equal(action.payload.steps[0]!.amount_inr, 8500);
    const approved = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    assert.equal(approved.body.status, 'in_progress');
    await waitFor(async () => findCase(record.case_id)?.status === 'resolved');
  });

  test('gateway denies writes without approval, with a tampered amount, or across cases', async () => {
    const token = await login();
    const record = await createCase(token);
    const prepared = await prepare(token, record.case_id, 'claim_plus_gap_plan');
    const caseRecord = findCase(record.case_id)!;
    const action = caseRecord.actions.at(-1)!;
    const lendingStep = action.payload.steps.find((step) => step.tool === 'lending.submit_application')!;

    await assert.rejects(
      () => invokeTool('lending.submit_application', lendingStep.input, { principal: customer, caseRecord }),
      (error: unknown) => error instanceof GatewayError && error.code === 'approval_required',
    );

    const token2 = signApprovalToken({
      case_id: caseRecord.case_id,
      action_id: action.action_id,
      payload_hash: action.payload_hash,
      sub: customer.sub,
    });
    await assert.rejects(
      () =>
        invokeTool(
          'lending.submit_application',
          { ...lendingStep.input, amount_inr: 80000 },
          { principal: customer, caseRecord, approval: { token: token2, action } },
        ),
      (error: unknown) => error instanceof GatewayError && error.code === 'approval_mismatch',
    );

    await assert.rejects(
      () => invokeTool('payments.get_balance', { case_id: 'SA-00000000' }, { principal: customer, caseRecord }),
      (error: unknown) => error instanceof GatewayError && error.code === 'case_scope',
    );
    await assert.rejects(
      () => invokeTool('payments.get_balance', { case_id: caseRecord.case_id, extra: true }, { principal: customer, caseRecord }),
      (error: unknown) => error instanceof GatewayError && error.code === 'invalid_input',
    );

    const audit = await api().get(`/api/cases/${prepared.case_id}/audit`).set(bearer(token));
    assert.ok(audit.body.events.some((event: { decision: string }) => event.decision === 'deny'));
  });
});

describe('partner callbacks', () => {
  async function inProgressCase() {
    const token = await login();
    const record = await createCase(token, UPI_MESSAGE);
    await api()
      .post(`/api/cases/${record.case_id}/transaction-confirmation`)
      .set(bearer(token))
      .send({ transaction_id: 'TXN-UPI-20261002-0214', recognized: false });
    const action = (await prepare(token, record.case_id, 'dispute_and_protect')).actions.at(-1)!;
    const approved = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    return approved.body as CaseRecord;
  }

  test('rejects unsigned callbacks and ignores duplicates', async () => {
    const record = await inProgressCase();
    const action = record.actions.at(-1)!;
    const event = {
      event_id: `n8n-test-${action.action_id}`,
      case_id: record.case_id,
      action_id: action.action_id,
      tool: 'payments.open_dispute',
      status: 'acknowledged',
      message: 'Dispute registered by n8n test',
    };
    const body = JSON.stringify(event);
    const unsigned = await api().post('/api/partners/callback').set('content-type', 'application/json').send(body);
    assert.equal(unsigned.status, 401);

    const signature = `sha256=${hmacSha256Hex('unit-test-callback-secret', body)}`;
    const first = await api()
      .post('/api/partners/callback')
      .set('content-type', 'application/json')
      .set('x-saathi-signature', signature)
      .send(body);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.applied, true);
    const duplicate = await api()
      .post('/api/partners/callback')
      .set('content-type', 'application/json')
      .set('x-saathi-signature', signature)
      .send(body);
    assert.equal(duplicate.body.duplicate, true);
  });
});
