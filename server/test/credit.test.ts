import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { bandFor, scoreReport, simulateAction } from '../src/credit';
import { fixtures } from '../src/fixtures';
import { GatewayError } from '../src/mcp/errors';
import { invokeAccountTool } from '../src/mcp/gateway';
import type { Principal } from '../src/types';
import { api, bearer, login, RIYA } from './helpers';

const riyaReport = fixtures.credit.reports['demo-customer-03']!;

describe('credit score (simulated bureau MCP)', () => {
  it('scores reports transparently on the 300-900 scale', () => {
    const riya = scoreReport(riyaReport);
    assert.equal(riya.score, 733);
    assert.equal(riya.band, 'Good');
    assert.equal(riya.factors.find((factor) => factor.id === 'utilisation')?.value, '34% of limit');
    const arjun = scoreReport(fixtures.credit.reports['demo-customer-02']!);
    assert.equal(arjun.band, 'Excellent');
    assert.deepEqual([bandFor(780).band, bandFor(720).band, bandFor(660).band, bandFor(600).band, bandFor(500).band], ['Excellent', 'Good', 'Fair', 'Needs work', 'Poor']);
  });

  it('simulates what moves the score without touching the stored report', () => {
    const before = scoreReport(riyaReport).score;
    assert.equal(scoreReport(simulateAction(riyaReport, 'pay_card_to_10')).score - before, 70);
    assert.equal(scoreReport(simulateAction(riyaReport, 'miss_one_emi')).score - before, -60);
    assert.ok(scoreReport(simulateAction(riyaReport, 'take_small_loan')).score < before);
    assert.equal(riyaReport.payment_history.late_payments.length, 1, 'original report unchanged');
  });

  it('requires explicit consent and the account owner at the gateway', async () => {
    const support: Principal = { sub: 'support-agent-01', role: 'support', display_name: 'Support', scopes: ['case:read:any', 'support:act'] };
    const riya: Principal = { sub: 'demo-customer-03', role: 'customer', display_name: 'Riya', scopes: ['case:read'] };
    await assert.rejects(
      () => invokeAccountTool('bureau.get_credit_report', { purpose: 'self_check' }, { principal: riya, consent: false }),
      (error: unknown) => error instanceof GatewayError && error.code === 'consent_required',
    );
    await assert.rejects(
      () => invokeAccountTool('bureau.get_credit_report', { purpose: 'self_check' }, { principal: support, consent: true }),
      (error: unknown) => error instanceof GatewayError && error.code === 'case_scope',
    );
    await assert.rejects(
      () => invokeAccountTool('payments.get_balance', {}, { principal: riya, consent: true }),
      (error: unknown) => error instanceof GatewayError && error.code === 'unknown_tool',
    );
  });

  it('serves the score and simulations over the API through the MCP server', async () => {
    const token = await login(...RIYA);
    const score = await api().post('/api/credit/score').set(bearer(token)).send({ consent: true });
    assert.equal(score.status, 200);
    assert.equal(score.body.score, 733);
    assert.equal(score.body.soft_pull, true);
    const simulated = await api().post('/api/credit/simulate').set(bearer(token)).send({ consent: true, action: 'pay_card_to_10' });
    assert.equal(simulated.body.after, 803);
    const refused = await api().post('/api/credit/score').set(bearer(token)).send({});
    assert.equal(refused.status, 422);
  });
});
