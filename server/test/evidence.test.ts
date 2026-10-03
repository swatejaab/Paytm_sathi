import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { settings } from '../src/config';
import { analyzeCaseWithOpenAI, providers, transcribeWithSarvam } from '../src/integrations';
import { api, bearer, buildPdf, chat, createCase, login, RIYA } from './helpers';

const originalSettings = { ...settings };
const originalProviders = { ...providers };
afterEach(() => {
  Object.assign(settings, originalSettings);
  Object.assign(providers, originalProviders);
});

describe('document evidence', () => {
  test('uploaded policy evidence cites its own page and gates automated steps', async () => {
    const token = await login(...RIYA);
    const record = await createCase(token, 'Papa is in hospital. Please help with the policy and bill.');
    const upload = await api()
      .post(`/api/cases/${record.case_id}/documents`)
      .set(bearer(token))
      .field('document_type', 'policy')
      .attach('file', Buffer.from('[Page 2]\nInpatient room expenses require receipts under clause R-7.'), {
        filename: 'uploaded-policy.txt',
        contentType: 'text/plain',
      });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));

    const evidence = (await api().get(`/api/cases/${record.case_id}/evidence`).set(bearer(token))).body;
    const citation = evidence.retrieved_evidence[0];
    assert.equal(citation.document_id, upload.body.document_id);
    assert.equal(citation.document_name, 'uploaded-policy.txt');
    assert.equal(citation.page, 2);
    assert.notEqual(citation.document_id, 'POLICY-DEMO-001');
    assert.equal(evidence.demo_only, false);

    const afterUpload = (await api().get(`/api/cases/${record.case_id}`).set(bearer(token))).body;
    assert.equal(afterUpload.context.slots.has_insurance.value, true);
    assert.match(afterUpload.assistant_message, /couldn't confidently determine your coverage/);

    await chat(token, 'Insurance should cover about ₹40,000', record.case_id);
    await chat(token, 'The bill is ₹70,000', record.case_id);
    const updated = await chat(token, 'I can pay ₹5,000', record.case_id);
    assert.equal(updated.decision?.calculation?.exact_gap_inr, 25000);
    assert.equal(updated.decision?.requires_verification, true);
    assert.equal(updated.decision?.recommended_option_id, 'human_support');
  });

  test('PDF upload extracts page text without storing the original file', async () => {
    const token = await login();
    const record = await createCase(token);
    const upload = await api()
      .post(`/api/cases/${record.case_id}/documents`)
      .set(bearer(token))
      .field('document_type', 'policy')
      .attach('file', buildPdf('Synthetic policy clause R-7 covers inpatient treatment.'), {
        filename: 'synthetic-policy.pdf',
        contentType: 'application/pdf',
      });
    assert.equal(upload.status, 201, JSON.stringify(upload.body));
    assert.equal(upload.body.page_count, 1);
    const saved = (await api().get(`/api/cases/${record.case_id}`).set(bearer(token))).body;
    assert.ok(saved.uploaded_documents[0].text.startsWith('[Page 1]'));
    assert.match(saved.uploaded_documents[0].text, /R-7/);
  });

  test('document upload rejects unsupported files and redacts contact identifiers', async () => {
    const token = await login();
    const record = await createCase(token);
    const rejected = await api()
      .post(`/api/cases/${record.case_id}/documents`)
      .set(bearer(token))
      .field('document_type', 'bill')
      .attach('file', Buffer.from('not a document'), { filename: 'bill.exe', contentType: 'application/octet-stream' });
    assert.equal(rejected.status, 422);

    await api()
      .post(`/api/cases/${record.case_id}/documents`)
      .set(bearer(token))
      .field('document_type', 'bill')
      .attach('file', Buffer.from('Contact riya@example.org or 9876543210'), { filename: 'bill.txt', contentType: 'text/plain' });
    const saved = (await api().get(`/api/cases/${record.case_id}`).set(bearer(token))).body;
    assert.equal(saved.uploaded_documents[0].text, 'Contact [REDACTED_EMAIL] or [REDACTED_PHONE]');
  });
});

describe('external providers', () => {
  test('OpenAI endpoint requires explicit consent and an enabled provider', async () => {
    const token = await login();
    const record = await createCase(token);
    settings.openaiEnabled = false;
    const noConsent = await api()
      .post(`/api/cases/${record.case_id}/analyze`)
      .set(bearer(token))
      .send({ confirm_external_processing: false });
    const disabled = await api()
      .post(`/api/cases/${record.case_id}/analyze`)
      .set(bearer(token))
      .send({ confirm_external_processing: true });
    assert.equal(noConsent.status, 403);
    assert.equal(disabled.status, 503);
  });

  test('Sarvam endpoint requires explicit consent', async () => {
    const token = await login();
    settings.sarvamEnabled = false;
    const noConsent = await api()
      .post('/api/voice/transcribe')
      .set(bearer(token))
      .attach('file', Buffer.from('synthetic audio'), { filename: 'voice.wav', contentType: 'audio/wav' });
    const disabled = await api()
      .post('/api/voice/transcribe')
      .set(bearer(token))
      .field('consent_to_transcribe', 'true')
      .attach('file', Buffer.from('synthetic audio'), { filename: 'voice.wav', contentType: 'audio/wav' });
    assert.equal(noConsent.status, 403);
    assert.equal(disabled.status, 503);
  });

  test('OpenAI adapter sends redacted structured evidence', async () => {
    settings.openaiEnabled = true;
    settings.openaiApiKey = 'unit-test-key';
    const captured: Record<string, unknown> = {};
    providers.createOpenAIClient = (options) => {
      captured.options = options;
      return {
        chat: {
          completions: {
            create: async (params) => {
              Object.assign(captured, params);
              return {
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        summary: 'The uploaded policy discusses inpatient expenses.',
                        observations: ['Clause page evidence is available.'],
                        missing_information: [],
                        follow_up_questions: [],
                      }),
                    },
                  },
                ],
              };
            },
          },
        },
      };
    };
    const result = await analyzeCaseWithOpenAI('Policy for demo@example.org', {
      event_type: 'hospitalization',
      documents: [{ document_type: 'policy', document_name: 'policy.txt', text: '[Page 2] Inpatient coverage details.' }],
      retrieved_evidence: [{ document_id: 'DOC-1', clause_id: 'R-7', page: 2, title: 'Inpatient cover', text: 'Synthetic cited policy passage.' }],
    });
    const sent = JSON.stringify(captured.messages);
    assert.ok(!sent.includes('demo@example.org'));
    assert.ok(sent.includes('DOC-1'));
    assert.deepEqual(captured.response_format, { type: 'json_object' });
    assert.ok(result.summary.startsWith('The uploaded policy'));
  });

  test('Sarvam adapter uses the documented multipart contract', async () => {
    settings.sarvamEnabled = true;
    settings.sarvamApiKey = 'unit-test-key';
    const captured: { url?: string; headers?: unknown; form?: FormData } = {};
    providers.fetch = async (url, init) => {
      captured.url = url;
      captured.headers = init?.headers;
      captured.form = init?.body as FormData;
      return new Response(JSON.stringify({ transcript: 'Papa hospital mein hain.', language_code: 'hi-IN', request_id: 'unit-test' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const result = await transcribeWithSarvam(Buffer.from('synthetic-audio'), 'voice.wav', 'audio/wav');
    assert.equal(captured.url, 'https://api.sarvam.ai/speech-to-text');
    assert.deepEqual(captured.headers, { 'api-subscription-key': 'unit-test-key' });
    assert.equal(captured.form?.get('model'), 'saaras:v4');
    assert.equal(captured.form?.get('language_code'), 'unknown');
    assert.equal(result.transcript, 'Papa hospital mein hain.');
    assert.equal(result.language_code, 'hi-IN');
  });
});
