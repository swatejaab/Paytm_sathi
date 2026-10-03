import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseBillQuery, parseStatedAmount } from '../src/decision';

describe('bill question parsing', () => {
  const cases: [string, Partial<ReturnType<typeof parseBillQuery>>][] = [
    ['i have a emergency of 80000 need to pay hospital bill', { bill_inr: 80000, can_pay_inr: null }],
    ['I have a medical emergency of 70', { bill_inr: 70000, assumed_thousands: true }],
    ['hospital bill is 1.5 lakh, I can pay 20000', { bill_inr: 150000, can_pay_inr: 20000 }],
    ['my father is admitted, bill 45000, 3 days', { bill_inr: 45000, room_days: 3 }],
    ['bill ₹2,40,000 and I have only 15k', { bill_inr: 240000, can_pay_inr: 15000 }],
    ['Papa is 62 years old, bill 95000', { bill_inr: 95000 }],
    ['I can manage to pay 25000', { bill_inr: null, can_pay_inr: 25000 }],
  ];
  for (const [message, expected] of cases) {
    it(message, () => {
      const parsed = parseBillQuery(message);
      for (const [key, value] of Object.entries(expected)) assert.equal(parsed[key as keyof typeof parsed], value, key);
    });
  }

  it('reads bare and marked amounts', () => {
    assert.equal(parseStatedAmount('a payment of 8500 I did not make'), 8500);
    assert.equal(parseStatedAmount('Rs 2,450 failed'), 2450);
    assert.equal(parseStatedAmount('3 days ago'), null);
  });
});

describe('emergency wording', () => {
  it('treats an emergency with an amount as hospital, but not an emergency fund question', async () => {
    const { classifyEvent } = await import('../src/decision');
    assert.equal(classifyEvent('i have a emergancy of 1lakh now what should i do').event_type, 'hospitalization');
    assert.equal(classifyEvent('how much emergency fund should I keep').event_type, 'general_financial_support');
    assert.equal(classifyEvent('emergency, refund of 2000 not credited').event_type, 'failed_refund');
  });
});
