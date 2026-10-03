import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { assessAffordability, parseIndianAmount, purchaseCategory } from '../src/afford';
import { buildForecast } from '../src/forecast';
import { api, bearer, login } from './helpers';

describe('cash-flow copilot', () => {
  it('forecasts the pre-payday crunch day by day', () => {
    const forecast = buildForecast('demo-customer-01')!;
    assert.equal(forecast.payday, '2026-10-10');
    assert.equal(forecast.first_negative_date, '2026-10-05');
    assert.deepEqual(forecast.lowest, { date: '2026-10-07', balance_inr: -18100 });
    assert.equal(forecast.crunch_inr, 18100);
    assert.equal(forecast.safe_to_spend_inr, 0);
    assert.equal(forecast.days.length, 31);
    assert.equal(forecast.end_balance_inr, 23400 - 12000 - 4000 - 12000 - 13500 + 90000 - 2800 - 5000 - 18400);
  });

  it('prices fixes and finds the cheapest plan, plus one without a new loan', () => {
    const forecast = buildForecast('demo-customer-01')!;
    const ids = forecast.fixes.map((fix) => fix.id);
    assert.ok(ids.includes('shift_emi') && ids.includes('card_minimum') && ids.includes('bridge_loan'));
    assert.deepEqual(forecast.best_plan?.fix_ids, ['bridge_loan']);
    assert.deepEqual(forecast.plan_without_new_loan?.fix_ids.sort(), ['card_minimum', 'shift_emi']);
    assert.ok(forecast.plan_without_new_loan!.cost_inr > forecast.best_plan!.cost_inr);
  });

  it('answers what-if questions', () => {
    const later = buildForecast('demo-customer-01', { salary_delay_days: 5 })!;
    assert.equal(later.payday, '2026-10-15');
    assert.ok(later.crunch_inr > 18100);
    const healthy = buildForecast('demo-customer-02')!;
    assert.equal(healthy.crunch_inr, 0);
    assert.equal(healthy.safe_to_spend_inr, 21000);
  });
});

describe('can I afford it', () => {
  it('parses Indian amounts and categories', () => {
    assert.equal(parseIndianAmount('Can I afford a ₹1.2 lakh iPhone?'), 120000);
    assert.equal(parseIndianAmount('15L car'), 1500000);
    assert.equal(parseIndianAmount('laptop for 60k'), 60000);
    assert.equal(parseIndianAmount('Rs 1,20,000'), 120000);
    assert.equal(purchaseCategory('a new car'), 'vehicle');
    assert.equal(purchaseCategory('iPhone 17'), 'purchase');
  });

  it('suggests a short wait for a healthy profile and EMI with a warning for a stretched one', () => {
    const arjun = assessAffordability('demo-customer-02', { amount_inr: 120000, item: 'iPhone' })!;
    assert.equal(arjun.recommended_id, 'wait');
    assert.equal(arjun.scenarios.find((scenario) => scenario.id === 'wait')?.months, 2);
    assert.equal(arjun.warning, null);

    const riya = assessAffordability('demo-customer-01', { amount_inr: 120000, item: 'iPhone' })!;
    assert.equal(riya.scenarios.find((scenario) => scenario.id === 'cash')?.status, 'not_possible');
    assert.equal(riya.recommended_id, 'card_emi');
    assert.match(riya.warning ?? '', /INR 18,100 short/);
  });

  it('blocks credit that fails the affordability rules', () => {
    const riya = assessAffordability('demo-customer-01', { amount_inr: 1500000, item: 'car', category: 'vehicle' })!;
    assert.equal(riya.verdict, 'not_now');
    assert.ok(riya.scenarios.every((scenario) => scenario.status !== 'comfortable' && scenario.status !== 'manageable'));
  });

  it('serves the forecast and a free-text affordability question over the API', async () => {
    const token = await login();
    const forecast = await api().get('/api/forecast?salary_delay_days=3').set(bearer(token));
    assert.equal(forecast.status, 200);
    assert.equal(forecast.body.payday, '2026-10-13');
    const answer = await api().post('/api/afford').set(bearer(token)).send({ question: 'Can I afford a ₹1.2 lakh iPhone?' });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.amount_inr, 120000);
    const unclear = await api().post('/api/afford').set(bearer(token)).send({ question: 'Can I afford it?' });
    assert.equal(unclear.status, 422);
  });
});
