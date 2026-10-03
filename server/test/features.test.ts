import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { detectLanguage } from '../src/assistant/language';
import { understand } from '../src/assistant/nlu';
import { settings } from '../src/config';
import { calculateApr, calculateEmi } from '../src/decision';
import { amountsIn, inventedNumbers, providers } from '../src/integrations';
import { api, bearer, chat, createCase, lastReply, login, RIYA, UPI_MESSAGE } from './helpers';

describe('assets linked from PAN', () => {
  it('needs consent and the verified PAN before fetching anything', async () => {
    const token = await login('demo-customer-02', '1357');
    const before = await api().get('/api/assets').set(bearer(token));
    assert.equal(before.status, 200);
    assert.deepEqual(before.body, { linked: false, pan_on_file: 'AQXXXXXX0K' });

    const noConsent = await api().post('/api/assets/link').set(bearer(token)).send({ use_kyc_pan: true });
    assert.equal(noConsent.status, 422);
    const badFormat = await api().post('/api/assets/link').set(bearer(token)).send({ pan: '12345', consent: true });
    assert.equal(badFormat.status, 422);
    assert.match(badFormat.body.detail ?? badFormat.body.message ?? JSON.stringify(badFormat.body), /valid 10-character PAN/);
    const otherPan = await api().post('/api/assets/link').set(bearer(token)).send({ pan: 'BKXPK4821M', consent: true });
    assert.ok(otherPan.status >= 400 && otherPan.status < 500, String(otherPan.status));
    assert.match(JSON.stringify(otherPan.body), /does not match the one verified/);

    const still = await api().get('/api/assets').set(bearer(token));
    assert.equal(still.body.linked, false);
  });

  it("adds up Neha's stocks, mutual funds, FDs and savings into her net worth", async () => {
    const token = await login();
    const linked = await api().post('/api/assets/link').set(bearer(token)).send({ pan: 'bkxpk 4821m', consent: true });
    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    const portfolio = linked.body.portfolio;
    assert.equal(portfolio.pan_masked, 'BKXXXXXX1M');
    assert.equal(portfolio.net_worth_inr, 620000);
    assert.equal(portfolio.simulated, true);
    const byClass = Object.fromEntries(portfolio.classes.map((item: { id: string; value_inr: number }) => [item.id, item.value_inr]));
    assert.equal(byClass.stocks, 30000);
    assert.equal(byClass.mutual_funds, 498000);
    assert.equal(byClass.fixed_deposits, 20000);
    assert.equal(byClass.savings, 38420);
    assert.equal(portfolio.total_assets_inr - portfolio.total_liabilities_inr, portfolio.net_worth_inr);
    assert.equal(portfolio.history.at(-1).net_worth_inr, 620000);

    const read = await api().get('/api/assets').set(bearer(token));
    assert.equal(read.body.linked, true);
    assert.equal(read.body.portfolio.net_worth_inr, 620000);

    const record = await chat(token, 'What is my net worth?');
    assert.match(lastReply(record).content, /₹6,20,000/);
    assert.ok(lastReply(record).quick_replies?.some((reply) => reply.action === 'open_insights'));

    const unlinked = await api().delete('/api/assets/link').set(bearer(token));
    assert.equal(unlinked.body.linked, false);
    const after = await chat(token, 'How are my investments doing?');
    assert.match(lastReply(after).content, /link/i);
    const general = await chat(token, 'What is the difference between a mutual fund and a fixed deposit?');
    assert.doesNotMatch(lastReply(general).content, /Link your PAN/);
  });

  it('is not available to support staff', async () => {
    const token = await login('support-agent-01', '9999');
    const response = await api().get('/api/assets').set(bearer(token));
    assert.equal(response.status, 403);
  });
});

describe('applying for a loan or policy from a plan', () => {
  it("offers the loan only inside Saathi's recommended hospital plan", async () => {
    const token = await login();
    const record = await createCase(token);
    const response = await api().get(`/api/cases/${record.case_id}/product`).set(bearer(token));
    const best = record.decision?.options.find((option) => option.option_id === record.decision?.recommended_option_id);
    const hasLoan = best?.writes.some((write) => write.tool === 'lending.submit_application');
    if (!hasLoan) {
      assert.equal(response.status, 404);
      return;
    }
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.kind, 'loan');
    assert.equal(response.body.commission_considered, false);
    assert.equal(response.body.simulated, true);
    assert.equal(response.body.total_payable_inr, response.body.amount_inr + response.body.total_interest_inr + response.body.processing_fee_inr);
  });

  it('offers a term plan when Saathi recommends cover for a family', async () => {
    const token = await login(...RIYA);
    const record = await createCase(token, 'I want to buy a term life insurance');
    const response = await api().get(`/api/cases/${record.case_id}/product`).set(bearer(token));
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal(response.body.kind, 'insurance');
    assert.equal(response.body.sum_assured_inr, 6000000);
    assert.equal(response.body.annual_premium_inr, 6600);
    assert.equal(response.body.monthly_equivalent_inr, 550);
  });

  it('offers nothing when Saathi is not suggesting a product', async () => {
    const token = await login();
    const record = await createCase(token, UPI_MESSAGE);
    const response = await api().get(`/api/cases/${record.case_id}/product`).set(bearer(token));
    assert.equal(response.status, 404);
    assert.match(JSON.stringify(response.body), /isn't suggesting a loan or a policy/);

    const other = await login('demo-customer-02', '1357');
    const foreign = await api().get(`/api/cases/${record.case_id}/product`).set(bearer(other));
    assert.ok([403, 404].includes(foreign.status));
  });

  it('does not sell products when asked directly in chat', async () => {
    const token = await login('demo-customer-02', '1357');
    const record = await chat(token, 'Give me a personal loan');
    assert.match(lastReply(record).content, /doesn't push loans or policies/);
    const hinglish = await chat(token, 'Mujhe ek insurance policy chahiye');
    assert.match(lastReply(hinglish).content, /loan ya policy nahi bechta|doesn't push loans or policies/);
    assert.equal(hinglish.decision, null);
  });
});

describe('understanding what the customer needs money for', () => {
  const originalSettings = { ...settings };
  const originalProviders = { ...providers };
  afterEach(() => {
    Object.assign(settings, originalSettings);
    Object.assign(providers, originalProviders);
  });

  // A stand-in for OpenAI that classifies every message the same way.
  function stubInterpreter(reply: Record<string, unknown>) {
    settings.openaiEnabled = true;
    settings.openaiApiKey = 'unit-test-key';
    const sent: string[] = [];
    providers.createOpenAIClient = () => ({
      chat: {
        completions: {
          create: async (params: { messages: Array<{ content: string }> }) => {
            sent.push(params.messages.map((message) => message.content).join('\n'));
            return { choices: [{ message: { content: JSON.stringify(reply) } }] };
          },
        },
      },
    });
    return sent;
  }
  const setAi = (token: string, ai: boolean) => api().post('/api/consents').set(bearer(token)).send({ ai });

  it('treats "I need 60000 to buy a car" as a purchase without asking what the money is for', async () => {
    for (const message of ['I need 60000 to buy a car', 'Want to purchase a laptop for 80k', 'Mujhe 5 lakh ki car leni hai', 'I need ₹8 lakh for a car']) {
      const u = understand(message);
      assert.equal(u.journey, 'afford', message);
      assert.ok(u.item, message);
    }
    assert.equal(understand('My phone bill is 2000').journey, 'bill');
    const token = await login(...RIYA);
    const record = await chat(token, 'I need 60000 to buy a car');
    assert.doesNotMatch(lastReply(record).content, /What is the ₹60,000 for/);
    assert.equal(record.context?.journey, 'afford');
    assert.equal(record.context?.slots.purchase_inr?.value, 60000);
    assert.equal(record.context?.slots.purchase_item?.value, 'car');
  });

  it('lets the AI assistant read a message the rules cannot place, then runs the right journey', async () => {
    const token = await login('demo-customer-02', '1357');
    await setAi(token, true);
    const sent = stubInterpreter({ intent: 'afford', amount_inr: 45000, item: 'gaming console', target_date: null, restated: 'You want to buy a ₹45,000 gaming console this month.' });
    const record = await chat(token, 'Son keeps asking for a PS5, 45000 hai, doable this month? my number is 9876543210');
    assert.ok(sent.some((text) => text.includes('Classify one message')));
    assert.ok(!sent.join('\n').includes('9876543210'), 'contact numbers are redacted before OpenAI');
    assert.equal(record.context?.journey, 'afford');
    assert.equal(record.context?.slots.purchase_inr?.value, 45000);
    assert.equal(record.messages.find((message) => message.role === 'user')?.understood, 'You want to buy a ₹45,000 gaming console this month.');
    assert.doesNotMatch(lastReply(record).content, /What is the/);
    await setAi(token, false);
  });

  it('never uses an amount the customer did not write', async () => {
    const token = await login('demo-customer-02', '1357');
    await setAi(token, true);
    stubInterpreter({ intent: 'afford', amount_inr: 99999, item: 'sofa set', target_date: null, restated: 'You want a ₹99,999 sofa set.' });
    const record = await chat(token, 'Thinking about getting a new sofa set for the living room soon');
    assert.equal(record.context?.journey, 'afford');
    assert.equal(record.context?.slots.purchase_inr, undefined);
    assert.match(lastReply(record).content, /How much does the sofa set cost\?/);
    assert.doesNotMatch(record.messages.find((message) => message.role === 'user')?.understood ?? '', /99,999/);
    await setAi(token, false);
  });

  it('asks before using AI to understand, and falls back to a clarifying question if declined', async () => {
    const token = await login('demo-customer-02', '1357');
    await setAi(token, false);
    stubInterpreter({ intent: 'unclear', amount_inr: null, item: null, target_date: null, restated: 'Unclear.' });
    let record = await chat(token, 'Need 30000 urgently, what do I do?');
    assert.match(lastReply(record).content, /work out what you need/);
    assert.ok(lastReply(record).quick_replies?.some((reply) => reply.label === 'Allow AI answers'));
    record = await chat(token, 'Not now', record.case_id);
    assert.match(lastReply(record).content, /What is the ₹30,000 for\?/);
  });
});

describe('loan cost disclosure', () => {
  it('reports an APR that includes fees and is never below the interest rate', () => {
    const emi = calculateEmi(15000, 14, 3);
    assert.ok(Math.abs(calculateApr(15000, 0, emi.emi_inr, 3) - 14) < 0.5);
    const apr = calculateApr(15000, 150, emi.emi_inr, 3);
    assert.ok(apr > 14 && apr < 30, String(apr));
    const long = calculateEmi(200000, 12, 24);
    const longApr = calculateApr(200000, 2000, long.emi_inr, 24);
    assert.ok(longApr > 12 && longApr < 13.5, String(longApr));
  });
});

describe('chatting in Indian languages', () => {
  it('detects the script the customer writes in', () => {
    assert.equal(detectLanguage('मेरे पापा अस्पताल में हैं, बिल बहुत ज़्यादा है'), 'hi-IN');
    assert.equal(detectLanguage('माझे बाबा रुग्णालयात आहेत', 'mr-IN'), 'mr-IN');
    assert.equal(detectLanguage('என் அப்பா மருத்துவமனையில் இருக்கிறார்'), 'ta-IN');
    assert.equal(detectLanguage('আমার বাবা হাসপাতালে আছেন'), 'bn-IN');
    assert.equal(detectLanguage('నా తండ్రి ఆసుపత్రిలో ఉన్నారు'), 'te-IN');
    assert.equal(detectLanguage('Papa hospital mein hain'), null);
    assert.equal(detectLanguage('₹80,000 OK'), null);
  });

  it('reads amounts written in Indian digits and guards translated numbers', () => {
    assert.deepEqual(amountsIn('बिल ₹८०,००० है'), amountsIn('bill ₹80,000'));
    assert.deepEqual(inventedNumbers('You can pay ₹15,000 now', new Set(['15000'])), []);
    assert.ok(inventedNumbers('You can pay ₹99,000 now', new Set(['15000'])).length > 0);
  });

  it('explains plainly when translation is switched off instead of guessing', async () => {
    const token = await login();
    const record = await chat(token, 'मेरे पापा अस्पताल में हैं और बिल बहुत ज़्यादा है');
    const reply = lastReply(record).content;
    assert.match(reply, /Hindi/);
    assert.equal(record.messages.find((message) => message.role === 'user')?.language, 'hi-IN');
    assert.equal(record.decision, null);
  });
});
