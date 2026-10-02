import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { calculateEmiShortfall } from '../src/decision';
import type { CaseRecord } from '../src/types';
import { api, bearer, createCase, login, waitFor } from './helpers';

const EMI_MESSAGE = 'Salary delayed hai, is mahine EMI bharne ke paise kam hain. Kya options hain?';

describe('EMI shortfall journey', () => {
  it('calculates the shortfall from balance and committed spending', () => {
    assert.deepEqual(calculateEmiShortfall({ emi_inr: 12000, account_balance_inr: 23400, committed_before_due_inr: 16000 }), {
      emi_inr: 12000,
      available_before_due_inr: 7400,
      shortfall_inr: 4600,
      formula: 'max(emi - max(account_balance - committed_before_due, 0), 0)',
    });
    assert.equal(calculateEmiShortfall({ emi_inr: 5000, account_balance_inr: 3000, committed_before_due_inr: 9000 }).shortfall_inr, 5000);
    assert.equal(calculateEmiShortfall({ emi_inr: 5000, account_balance_inr: 20000, committed_before_due_inr: 0 }).shortfall_inr, 0);
    assert.throws(() => calculateEmiShortfall({ emi_inr: -1, account_balance_inr: 0, committed_before_due_inr: 0 }));
  });

  it('recommends moving the due date past payday and explains it in Hinglish', async () => {
    const token = await login();
    const record = await createCase(token, EMI_MESSAGE);
    assert.equal(record.event_type, 'emi_shortfall');
    assert.equal(record.status, 'options_ready');
    assert.deepEqual(record.agent_runs?.[0]?.steps.map((step) => step.node), [
      'classifier',
      'consent_gate',
      'context_retriever',
      'policy_rag',
      'emi_auditor',
      'decision',
      'explainer',
    ]);
    const facts = Object.fromEntries(record.decision!.facts.map((fact) => [fact.name, fact.value]));
    assert.equal(facts.shortfall_inr, 4600);
    const best = record.decision!.options.find((option) => option.recommended)!;
    assert.equal(best.option_id, 'shift_due_date');
    assert.equal(best.writes[0]?.tool, 'lending.request_due_date_change');
    assert.equal(best.writes[0]?.input.requested_due_date, '2026-10-11');

    const bridge = record.decision!.options.find((option) => option.option_id === 'bridge_loan')!;
    assert.equal(bridge.metrics.borrow_inr, 4600, 'bridge borrows only the shortfall');
    const savings = record.decision!.options.find((option) => option.option_id === 'use_savings')!;
    assert.ok(savings.guardrails.some((guardrail) => guardrail.rule === 'Emergency buffer protected' && !guardrail.passed));
    const bounce = record.decision!.options.find((option) => option.option_id === 'let_it_bounce')!;
    assert.equal(bounce.metrics.extra_cost_inr, 590 + 50 * 5);

    assert.equal(record.language, 'hinglish');
    assert.match(record.assistant_message, /INR 4,600 kam pad rahe hain/);
  });

  it('runs the approved due-date change through the gateway to resolution', async () => {
    const token = await login();
    const record = await createCase(token, EMI_MESSAGE);
    const prepared = await api().post(`/api/cases/${record.case_id}/actions`).set(bearer(token)).send({ option_id: 'shift_due_date' });
    assert.equal(prepared.status, 201);
    const action = prepared.body.actions.at(-1);
    const approved = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.actions.at(-1).partner_requests[0].tool, 'lending.request_due_date_change');

    const resolved = await waitFor(async () => {
      const latest = await api().get(`/api/cases/${record.case_id}`).set(bearer(token));
      return latest.body.status === 'resolved' ? (latest.body as CaseRecord) : null;
    });
    assert.ok(resolved.timeline.some((entry) => /moved the EMI/.test(entry.title)));
  });

  it('routes a customer with no active loan to a specialist', async () => {
    const token = await login('demo-customer-02', '1357');
    const record = await createCase(token, 'My EMI payment might fail this month because salary delayed.');
    assert.equal(record.event_type, 'emi_shortfall');
    assert.equal(record.decision?.recommended_option_id, 'human_support');
    assert.match(record.assistant_message, /could not find an active loan/);
  });
});
