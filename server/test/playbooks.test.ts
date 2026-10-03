import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { signApprovalToken } from '../src/auth';
import { findCase } from '../src/db';
import { GatewayError } from '../src/mcp/errors';
import { invokeTool } from '../src/mcp/gateway';
import { evaluate } from '../src/playbooks/expressions';
import { classifyWithPlaybooks, PLAYBOOKS } from '../src/playbooks/registry';
import type { CaseRecord, Principal } from '../src/types';
import { api, bearer, createCase, login, RIYA, waitFor } from './helpers';

const REFUND_MESSAGE = 'INR 2,450 ka UPI payment failed ho gaya, paise kat gaye par refund nahi aaya.';
const neha: Principal = {
  sub: 'demo-customer-01',
  role: 'customer',
  display_name: 'Neha',
  scopes: ['case:read', 'action:approve', 'consent:manage', 'document:upload', 'case:create'],
};

describe('playbook registry', () => {
  it('loads every YAML playbook and routes messages by their triggers', () => {
    assert.deepEqual(PLAYBOOKS.map((playbook) => playbook.id).sort(), [
      'emi_shortfall',
      'failed_upi_refund',
      'general_support',
      'hospital_bill',
      'term_life',
      'upi_fraud',
    ]);
    assert.equal(classifyWithPlaybooks(REFUND_MESSAGE).playbook.id, 'failed_upi_refund');
    assert.equal(classifyWithPlaybooks('Papa hospital mein hain').playbook.id, 'hospital_bill');
    assert.equal(classifyWithPlaybooks('Unrecognized UPI debit, not mine').playbook.id, 'upi_fraud');
  });

  it('evaluates the safe expression language without eval', () => {
    const scope = { transaction: { occurred_at: '2026-09-30T11:22:00+05:30', amount_inr: 2450 }, today: '2026-10-03' };
    assert.equal(evaluate('days_between(transaction.occurred_at, today)', scope), 3);
    assert.equal(evaluate('max(3 - 1, 0) * 100', scope), 200);
    assert.equal(evaluate('transaction.amount_inr > 1000 && 2 == 2', scope), true);
    assert.throws(() => evaluate('process.exit(1)', scope), /Unknown/);
    assert.throws(() => evaluate('constructor', scope), /Unknown name/);
  });

  it('runs the declarative failed-refund journey end to end with no journey-specific code', async () => {
    const token = await login();
    const record = await createCase(token, REFUND_MESSAGE);
    assert.equal(record.playbook_id, 'failed_upi_refund');
    assert.equal(record.event_type, 'failed_refund');
    const question = record.pending_question as { mode: string; candidates: { transaction_id: string; status: string }[] };
    assert.equal(question.mode, 'select');
    assert.ok(question.candidates.every((candidate) => candidate.status === 'failed_debited'));

    const picked = await api()
      .post(`/api/cases/${record.case_id}/transaction-confirmation`)
      .set(bearer(token))
      .send({ transaction_id: question.candidates[0]!.transaction_id, recognized: false });
    const decided = picked.body as CaseRecord;
    const facts = Object.fromEntries(decided.decision!.facts.map((fact) => [fact.name, fact.value]));
    assert.deepEqual([facts.amount_inr, facts.days_since_debit, facts.days_late, facts.compensation_inr], [2450, 3, 2, 200]);
    assert.equal(decided.decision!.formula_version, 'failed-refund-v1');
    const best = decided.decision!.options.find((option) => option.recommended)!;
    assert.equal(best.option_id, 'raise_refund_trace');
    assert.deepEqual(best.writes[0]!.input, {
      case_id: record.case_id,
      transaction_id: 'TXN-UPI-20260930-1122',
      amount_inr: 2450,
      compensation_inr: 200,
    });

    const prepared = await api().post(`/api/cases/${record.case_id}/actions`).set(bearer(token)).send({ option_id: best.option_id });
    const action = prepared.body.actions.at(-1);
    await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    const resolved = await waitFor(async () => {
      const latest = await api().get(`/api/cases/${record.case_id}`).set(bearer(token));
      return latest.body.status === 'resolved' ? (latest.body as CaseRecord) : null;
    });
    assert.ok(resolved.timeline.some((entry) => /compensation credited/.test(entry.title)));
  });

  it('denies tools the active playbook does not declare', async () => {
    const token = await login();
    const record = await createCase(token, 'Salary delayed, EMI due this week.');
    const stored = findCase(record.case_id)!;
    await assert.rejects(
      () => invokeTool('hospital.get_bill', { case_id: record.case_id }, { principal: neha, caseRecord: stored }),
      (error: unknown) => error instanceof GatewayError && error.code === 'playbook_scope',
    );
  });

  it('rejects an inflated compensation claim at the gateway', async () => {
    const token = await login();
    const record = await createCase(token, REFUND_MESSAGE);
    const stored = findCase(record.case_id)!;
    const steps = [
      {
        tool: 'payments.raise_refund_trace',
        partner: 'test',
        amount_inr: 2450,
        summary: 'tampered',
        input: { case_id: record.case_id, transaction_id: 'TXN-UPI-20260930-1122', amount_inr: 2450, compensation_inr: 5000 },
      },
    ];
    const action = { action_id: 'ACT-TAMPER01', payload: { steps }, payload_hash: '', partner_requests: [] } as unknown as CaseRecord['actions'][number];
    const { hashPayload } = await import('../src/hashing');
    action.payload_hash = hashPayload(action.payload);
    const token2 = signApprovalToken({ case_id: record.case_id, action_id: action.action_id, payload_hash: action.payload_hash, sub: neha.sub });
    await assert.rejects(
      () => invokeTool('payments.raise_refund_trace', steps[0]!.input, { principal: neha, caseRecord: stored, approval: { token: token2, action } }),
      (error: unknown) => error instanceof GatewayError && /exceeds the regulatory/.test(error.message),
    );
  });
});

describe('term life and remembered consent', () => {
  it('sizes the protection gap and recommends full cover for a family', async () => {
    const token = await login(...RIYA);
    const record = await createCase(token, 'I want to buy a term life insurance');
    assert.equal(record.playbook_id, 'term_life');
    const facts = Object.fromEntries(record.decision!.facts.map((fact) => [fact.name, fact.value]));
    assert.deepEqual([facts.gap_inr, facts.recommended_cover_inr, facts.premium_inr], [5884100, 6000000, 6600]);
    assert.equal(record.decision!.recommended_option_id, 'buy_recommended');
  });

  it('tells a customer with no dependents that term cover is optional', async () => {
    const token = await login('demo-customer-02', '1357');
    const record = await createCase(token, 'Should I buy term life insurance?');
    assert.equal(record.decision!.recommended_option_id, 'keep_current');
  });

  it('applies a remembered records consent to new cases', async () => {
    const token = await login('demo-customer-02', '1357');
    await api().post('/api/consents').set(bearer(token)).send({ records: true });
    const record = await createCase(token, 'I am admitted in hospital. What should I do?', false);
    assert.equal(record.status, 'options_ready');
    assert.ok(!record.messages.some((message) => message.quick_replies?.some((reply) => reply.send === 'Yes, allow access')));
    assert.ok(record.timeline.some((entry) => entry.title === 'Access allowed (remembered choice)'));
    await api().post('/api/consents').set(bearer(token)).send({ records: false });
  });
});
