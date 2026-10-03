import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { entryText, parseHit } from '../src/cognee';
import { settings } from '../src/config';
import { providers } from '../src/integrations';
import { createCase, login } from './helpers';

const originalFetch = providers.fetch;
const chunk = (id: string, kind: string, title: string, clause?: string) =>
  entryText({ id, kind: kind as never, title, document: 'health_policy_schedule.pdf', text: `${title} text.`, ...(clause ? { clause_id: clause, page: 4 } : {}) });

describe('Cognee knowledge graph', () => {
  before(() => {
    Object.assign(settings, { cogneeEnabled: true, cogneeApiKey: 'test-key', cogneeBaseUrl: 'https://cognee.test' });
    providers.fetch = async (url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { searchType?: string };
      assert.equal((init?.headers as Record<string, string>)['X-Api-Key'], 'test-key');
      const result =
        body.searchType === 'GRAPH_COMPLETION'
          ? ['Pure term insurance gives the most cover per rupee; aim for about 10 times your annual income.']
          : [{ text: chunk('policy-3.2', 'policy_clause', 'Room category limit', '3.2') }, { text: chunk('guide-term-vs-endowment', 'guide', 'Term insurance versus endowment plans') }];
      return new Response(JSON.stringify([{ dataset_id: 'x', dataset_name: 'saathi-knowledge', search_result: result }]), { status: url.includes('/search') ? 200 : 404 });
    };
  });
  after(() => {
    providers.fetch = originalFetch;
    Object.assign(settings, { cogneeEnabled: false });
  });

  it('round-trips citation tags', () => {
    const hit = parseHit(chunk('policy-3.2', 'policy_clause', 'Room category limit', '3.2'));
    assert.deepEqual([hit.entry_id, hit.kind, hit.clause_id, hit.page, hit.title], ['policy-3.2', 'policy_clause', '3.2', 4, 'Room category limit']);
  });

  it('retrieves policy clauses from Cognee in the hospital journey', async () => {
    const token = await login();
    const record = await createCase(token);
    const passages = record.evidence!.retrieved_evidence;
    assert.equal(passages[0]?.clause_id, '3.2');
    assert.equal(passages[0]?.retrieval, 'cognee');
    assert.equal(record.decision?.calculation?.exact_gap_inr, 15000, 'maths is unchanged by retrieval');
  });

  it('answers a general question from the knowledge graph with sources', async () => {
    const token = await login();
    const record = await createCase(token, 'What is the difference between term and endowment plans?');
    assert.equal(record.event_type, 'general_financial_support');
    assert.match(record.assistant_message, /Pure term insurance/);
    assert.match(record.assistant_message, /Sources: /);
  });

  it('falls back to the local index when Cognee fails', async () => {
    providers.fetch = async () => new Response('boom', { status: 503 });
    const token = await login();
    const record = await createCase(token);
    assert.ok(record.evidence!.retrieved_evidence.every((passage) => passage.retrieval === 'local_index'));
  });
});
