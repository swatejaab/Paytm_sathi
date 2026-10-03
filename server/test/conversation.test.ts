import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { understand } from '../src/assistant/nlu';
import type { CaseRecord } from '../src/types';
import { api, bearer, chat, lastReply, login, RIYA, waitFor } from './helpers';

const PRESET_AMOUNTS = /₹\s?80,000|₹\s?55,000|₹\s?10,000|₹\s?15,000|80K|55K|15K/i;
const ASK_CONSENT =
  "I understand your hospital bill is ₹5,00,000. So you don't have to type in your policy and bank details, I can check your health policy with your insurer, the hospital's bill, and what you can safely pay from your bank balance.";
const ASK_INSURANCE =
  'I understand your hospital bill is ₹5,00,000. Do you have health insurance? If yes, upload your policy or tell me the expected coverage.';

const allText = (record: CaseRecord) => record.messages.map((message) => message.content).join('\n');

describe('understanding what the customer said', () => {
  it('reads Indian amounts and what they refer to', () => {
    const u = understand('My bill is ₹5 lakh, insurance will cover 3L and I can pay 50k');
    assert.deepEqual(
      u.amounts.map((amount) => [amount.value, amount.role]),
      [
        [500000, 'bill'],
        [300000, 'insurance'],
        [50000, 'self_pay'],
      ],
    );
    assert.equal(understand('Hello').journey, null);
    assert.equal(understand('Hello').greeting, true);
    assert.deepEqual(understand('I am 34 years old').amounts, []);
  });
});

describe('Saathi conversations', () => {
  it('answers a greeting without any hospital content', async () => {
    const token = await login();
    const record = await chat(token, 'Hello');
    const reply = lastReply(record).content;
    assert.doesNotMatch(reply, /hospital|insurance|bill/i);
    assert.doesNotMatch(reply, PRESET_AMOUNTS);
    assert.equal(record.decision, null);
    assert.equal(record.title, 'New chat');
  });

  it('asks before reading any records and never uses a preset hospital case', async () => {
    const token = await login();
    const record = await chat(token, 'I am admitted in hospital and my bill is ₹5 lakh.');
    const reply = lastReply(record).content;
    assert.ok(reply.startsWith(ASK_CONSENT), reply);
    assert.doesNotMatch(allText(record), PRESET_AMOUNTS);
    assert.equal(record.context?.slots.bill_inr?.value, 500000);
    assert.equal(record.context?.awaiting, 'records_consent');
    assert.equal(record.context?.records, undefined, 'nothing is fetched before consent');
    assert.equal(record.decision, null);
    assert.equal(record.title, 'Hospital Bill Assistance');
  });

  it('asks the customer directly when they decline record access', async () => {
    const token = await login();
    let record = await chat(token, 'I am admitted in hospital and my bill is ₹5 lakh.');
    record = await chat(token, 'Not now', record.case_id);
    assert.ok(lastReply(record).content.startsWith(ASK_INSURANCE), lastReply(record).content);
    assert.equal(record.context?.awaiting, 'has_insurance');
    assert.doesNotMatch(allText(record), PRESET_AMOUNTS);
  });

  it('remembers earlier turns: ₹5 lakh bill, ₹3 lakh insurance, ₹50,000 now = ₹1,50,000 gap', async () => {
    const token = await login(...RIYA);
    let record = await chat(token, 'I am admitted in hospital and my bill is ₹5 lakh.');
    record = await chat(token, 'Yes, allow access', record.case_id);
    assert.equal(record.context?.awaiting, 'insurance_cover_inr', 'the policy is on file but there is no itemised bill to check');
    assert.equal(record.context?.slots.has_insurance?.source, 'insurer_record');
    record = await chat(token, 'Insurance should cover ₹3 lakh', record.case_id);
    assert.equal(record.context?.slots.insurance_cover_inr?.value, 300000);
    assert.equal(record.context?.gap?.exact_gap_inr, 200000, "Riya's records show nothing free to pay before salary");
    record = await chat(token, 'I can pay ₹50,000 now', record.case_id);
    assert.match(lastReply(record).content, /₹1,50,000/);
    assert.equal(record.status, 'options_ready');
    assert.deepEqual(
      [
        record.decision?.calculation?.bill_total_inr,
        record.decision?.calculation?.coverage_estimate_inr,
        record.decision?.calculation?.customer_contribution_inr,
        record.decision?.calculation?.exact_gap_inr,
      ],
      [500000, 300000, 50000, 150000],
    );
    assert.equal(lastReply(record).card?.type, 'plan');
    assert.equal(record.decision?.commission_considered, false);
    const facts = Object.fromEntries(record.decision!.facts.map((fact) => [fact.name, fact.source.type]));
    assert.equal(facts.bill_total_inr, 'customer_statement');
    assert.equal(facts.customer_contribution_inr, 'customer_statement', 'what the customer says replaces the records');

    const why = await chat(token, 'Why this plan?', record.case_id);
    assert.match(lastReply(why).content, /₹1,50,000/);
    assert.match(lastReply(why).content, /never on partner commission/);
  });

  it('keeps a new chat separate from the previous one', async () => {
    const token = await login(...RIYA);
    const first = await chat(token, 'I am admitted in hospital and my bill is ₹5 lakh.');
    await chat(token, 'Yes, insurance should cover ₹3 lakh', first.case_id);
    const second = await chat(token, 'My mother is in hospital, the bill is ₹2 lakh');
    assert.notEqual(second.case_id, first.case_id);
    assert.equal(second.context?.slots.bill_inr?.value, 200000);
    assert.equal(second.context?.slots.insurance_cover_inr, undefined);
    assert.match(lastReply(second).content, /₹2,00,000/);
    assert.doesNotMatch(allText(second), /5,00,000|3,00,000/);
    const reopened = (await api().get(`/api/cases/${first.case_id}`).set(bearer(token))).body as CaseRecord;
    assert.equal(reopened.context?.slots.bill_inr?.value, 500000);
  });

  it('takes an unrecognised ₹8,500 UPI payment through dispute and securing the account', async () => {
    const token = await login();
    let record = await chat(token, "I don't recognize a ₹8,500 UPI payment from my account");
    assert.equal(record.context?.journey, 'upi_fraud');
    assert.equal(record.title, 'Unknown UPI Transaction');
    record = await chat(token, 'Yes, allow access', record.case_id);
    assert.equal(lastReply(record).card?.type, 'transactions');
    const candidates = record.pending_question?.type === 'confirm_transaction' ? record.pending_question.candidates : [];
    assert.ok(candidates.length > 0 && candidates.every((candidate) => candidate.amount_inr === 8500));

    const confirmed = await api()
      .post(`/api/cases/${record.case_id}/transaction-confirmation`)
      .set(bearer(token))
      .send({ transaction_id: candidates[0]!.transaction_id, recognized: false });
    assert.equal(confirmed.status, 200);
    const decided = confirmed.body as CaseRecord;
    assert.equal(decided.decision?.recommended_option_id, 'dispute_and_protect');
    const dispute = decided.decision!.options.find((option) => option.option_id === 'dispute_and_protect')!;
    assert.deepEqual(dispute.writes.map((write) => write.tool), ['payments.open_dispute', 'payments.pause_upi']);
    assert.ok(decided.decision!.options.some((option) => option.option_id === 'secure_account'));

    const prepared = await api().post(`/api/cases/${record.case_id}/actions`).set(bearer(token)).send({ option_id: 'secure_account' });
    assert.equal(prepared.status, 201, JSON.stringify(prepared.body));
    const action = prepared.body.actions.at(-1);
    const approved = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    const done = await waitFor(async () => {
      const latest = (await api().get(`/api/cases/${record.case_id}`).set(bearer(token))).body as CaseRecord;
      return latest.actions.at(-1)?.partner_requests.every((request) => request.status === 'completed') ? latest : null;
    });
    assert.equal(done.actions.at(-1)?.partner_requests[0]?.tool, 'payments.pause_upi');

    const handoff = await api().post(`/api/cases/${record.case_id}/handoff`).set(bearer(token)).send({});
    assert.equal(handoff.status, 200);
  });

  it('understands a Hinglish EMI message with weekdays', async () => {
    const token = await login();
    const record = await chat(token, 'Mera EMI Friday ko hai lekin salary Monday ko aayegi.');
    assert.equal(record.language, 'hinglish');
    assert.equal(record.context?.journey, 'emi');
    assert.equal(record.context?.slots.emi_due_date?.value, '2026-10-09');
    assert.equal(record.context?.slots.salary_date?.value, '2026-10-12');
    assert.match(lastReply(record).content, /Samajh gaya/);
    assert.match(lastReply(record).content, /9 Oct/);
    assert.equal(record.title, 'EMI Payment Problem');
  });

  it('lists, renames and deletes conversations', async () => {
    const token = await login('demo-customer-02', '1357');
    const created = await chat(token, 'My father is in hospital and the bill is ₹1.2 lakh');
    const list = (await api().get('/api/cases').set(bearer(token))).body.cases as { case_id: string; title: string; message_count: number }[];
    const listed = list.find((item) => item.case_id === created.case_id);
    assert.equal(listed?.title, 'Hospital Bill Assistance');
    assert.ok(listed!.message_count >= 2);

    const renamed = await api().patch(`/api/cases/${created.case_id}`).set(bearer(token)).send({ title: 'Papa surgery' });
    assert.equal(renamed.status, 200);
    assert.equal(renamed.body.title, 'Papa surgery');
    const later = await chat(token, 'No insurance', created.case_id);
    assert.equal(later.title, 'Papa surgery', 'a renamed title is kept');

    const other = await login();
    assert.equal((await api().delete(`/api/cases/${created.case_id}`).set(bearer(other))).status, 404);
    assert.equal((await api().delete(`/api/cases/${created.case_id}`).set(bearer(token))).status, 204);
    assert.equal((await api().get(`/api/cases/${created.case_id}`).set(bearer(token))).status, 404);
    const after = (await api().get('/api/cases').set(bearer(token))).body.cases as { case_id: string }[];
    assert.ok(!after.some((item) => item.case_id === created.case_id));
  });
});

describe('goals and insights', () => {
  it('creates a car goal, computes progress and uses it when checking a purchase', async () => {
    const token = await login(...RIYA);
    const existing = (await api().get('/api/goals').set(bearer(token))).body.goals as { goal_id: string }[];
    for (const goal of existing) await api().delete(`/api/goals/${goal.goal_id}`).set(bearer(token));

    const created = await api().post('/api/goals').set(bearer(token)).send({
      name: 'Car',
      type: 'vehicle',
      target_inr: 1000000,
      target_date: '2028-12-31',
      current_savings_inr: 200000,
      monthly_contribution_inr: null,
      priority: 'high',
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.remaining_inr, 800000);
    assert.equal(created.body.progress_pct, 20);
    assert.ok(created.body.required_monthly_inr > 0);

    const past = await api().post('/api/goals').set(bearer(token)).send({
      name: 'Old goal',
      type: 'custom',
      target_inr: 1000,
      target_date: '2020-01-01',
      current_savings_inr: 0,
      monthly_contribution_inr: null,
      priority: 'low',
    });
    assert.equal(past.status, 422);

    let record = await chat(token, 'Can I afford an iPhone for ₹1 lakh?');
    if (record.context?.awaiting === 'records_consent') record = await chat(token, 'Yes, allow access', record.case_id);
    const card = lastReply(record).card as { type: string; assessment?: { amount_inr: number; goal_impact?: { focus_goal: string } | null } };
    assert.equal(card.type, 'afford');
    assert.equal(card.assessment?.amount_inr, 100000);
    assert.equal(card.assessment?.goal_impact?.focus_goal, 'Car');
    assert.match(lastReply(record).content, /Car goal/);

    const paused = await api().patch(`/api/goals/${created.body.goal_id}`).set(bearer(token)).send({ status: 'paused' });
    assert.equal(paused.body.status, 'paused');
    assert.equal((await api().delete(`/api/goals/${created.body.goal_id}`).set(bearer(token))).status, 204);
  });

  it('serves KPIs, charts and proactive insights from account records', async () => {
    const token = await login();
    const response = await api().get('/api/insights').set(bearer(token));
    assert.equal(response.status, 200);
    const body = response.body;
    for (const key of ['income_inr', 'spending_inr', 'savings_inr', 'upcoming_obligations_inr', 'outstanding_debt_inr']) {
      assert.equal(typeof body.kpis[key], 'number', key);
    }
    assert.ok(body.kpis.health.score >= 0 && body.kpis.health.score <= 100);
    assert.equal(body.kpis.health.parts.reduce((sum: number, part: { score: number }) => sum + part.score, 0), body.kpis.health.score);
    assert.equal(body.months.length, 6);
    assert.ok(body.categories.length > 0);
    assert.ok(body.insights.some((insight: { id: string }) => insight.id === 'spending-change'));

    const context = (await api().get('/api/financial-context').set(bearer(token))).body;
    assert.equal(typeof context.monthlyIncome, 'number');
    assert.ok('emergencyFund' in context);
  });
});
