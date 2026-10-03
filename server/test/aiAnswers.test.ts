import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { settings } from '../src/config';
import { providers } from '../src/integrations';
import { api, bearer, login } from './helpers';

const originalSettings = { ...settings };
const originalProviders = { ...providers };
afterEach(() => {
  Object.assign(settings, originalSettings);
  Object.assign(providers, originalProviders);
});

// Replaces the OpenAI client with one that returns a fixed answer and records what was sent.
function mockOpenAI(answer: string) {
  const sent: { messages?: { role: string; content: string }[] }[] = [];
  settings.openaiEnabled = true;
  settings.openaiApiKey = 'unit-test-key';
  providers.createOpenAIClient = (() => ({
    chat: {
      completions: {
        create: async (params: { messages: { role: string; content: string }[] }) => {
          sent.push(params);
          return { choices: [{ message: { content: JSON.stringify({ answer }) } }] };
        },
      },
    },
  })) as unknown as typeof providers.createOpenAIClient;
  return sent;
}

async function intake(token: string, message: string, ai: boolean) {
  const response = await api()
    .post('/api/cases/intake')
    .set(bearer(token))
    .send({ message, consent_to_read_case_data: true, confirm_external_processing: ai });
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body;
}

describe('answers from the customer’s own account', () => {
  it('OpenAI writes the reply from account facts and the calculated plan', async () => {
    const sent = mockOpenAI('Riya, your bill gap is INR 15,000. You have INR 23,400 in your account, so pay INR 10,000 now and take the 3-month plan.');
    const token = await login();
    const record = await intake(token, 'Hospital bill is INR 80,000, what should I do?', true);
    const reply = record.messages.at(-1);
    assert.equal(reply.source, 'openai');
    assert.match(reply.content, /23,400/);
    const payload = JSON.parse(sent.at(-1)!.messages!.at(-1)!.content);
    assert.equal(payload.account_facts.balance_inr, 23400);
    assert.match(payload.saathi_draft, /Exact gap/);
    assert.ok(payload.case_facts.calculation);
  });

  it('falls back to the calculated text when the AI adds a number', async () => {
    mockOpenAI('You should borrow INR 99,999 today.');
    const token = await login();
    const record = await intake(token, 'Hospital bill is INR 80,000, what should I do?', true);
    const reply = record.messages.at(-1);
    assert.notEqual(reply.source, 'openai');
    assert.match(reply.content, /^Exact gap/);
  });

  it('does not send account data to OpenAI without consent', async () => {
    const sent = mockOpenAI('This should not be used.');
    const token = await login('demo-customer-02', '1357');
    await api().post('/api/consents').set(bearer(token)).send({ ai: false });
    const record = await intake(token, 'Hospital bill is INR 80,000, what should I do?', false);
    assert.equal(sent.length, 0);
    assert.match(record.messages.at(-1).content, /^Exact gap/);
  });
});
