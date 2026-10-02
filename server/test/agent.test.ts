import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runAgent } from '../src/agent/graph';
import { detectLanguage } from '../src/agent/explainer';
import { insertCase } from '../src/db';
import type { AgentRun, CaseRecord, Principal } from '../src/types';
import { api, bearer, createCase, HOSPITAL_MESSAGE, login, UPI_MESSAGE, waitFor } from './helpers';

const graphRuns = (record: CaseRecord): AgentRun[] => record.agent_runs ?? [];
const nodesOf = (run: AgentRun | undefined) => run?.steps.map((step) => step.node) ?? [];

describe('agent graph', () => {
  it('runs the hospital journey through every specialist node in order', async () => {
    const token = await login();
    const record = await createCase(token);
    const run = graphRuns(record)[0];
    assert.equal(run?.trigger, 'intake');
    assert.deepEqual(nodesOf(run), [
      'classifier',
      'consent_gate',
      'context_retriever',
      'policy_rag',
      'bill_auditor',
      'decision',
      'explainer',
    ]);
    assert.ok(run!.steps.every((step) => step.status === 'ok'));
    const toolsByNode = Object.fromEntries(run!.steps.map((step) => [step.node, step.tools]));
    assert.deepEqual(toolsByNode.classifier, []);
    assert.ok(toolsByNode.policy_rag!.includes('knowledge.search_policy'));
    assert.ok(toolsByNode.bill_auditor!.includes('hospital.get_bill'));
    assert.ok(toolsByNode.decision!.includes('lending.get_offers'));
    assert.equal(record.status, 'options_ready');
    assert.equal(record.decision?.calculation?.exact_gap_inr, 15000);
  });

  it('answers a Hinglish customer in Hinglish without inventing numbers', async () => {
    const token = await login();
    const record = await createCase(token, HOSPITAL_MESSAGE);
    assert.equal(record.language, 'hinglish');
    assert.match(record.assistant_message, /Sabse accha raasta/);
    assert.match(record.assistant_message, /INR 15,000/);
    const amounts = record.assistant_message.match(/INR [\d,]+/g) ?? [];
    const known = new Set(
      [80000, 55000, 10000, 15000, ...(record.decision?.options.flatMap((option) => [option.metrics.monthly_emi_inr, option.metrics.borrow_inr]) ?? [])].map(
        (value) => `INR ${value.toLocaleString('en-IN')}`,
      ),
    );
    for (const amount of amounts) assert.ok(known.has(amount), `${amount} was not produced by the decision service`);
  });

  it('answers an English customer in English', async () => {
    const token = await login();
    const record = await createCase(token, 'My father is admitted in hospital and the bill is INR 80,000. What should I do?');
    assert.equal(record.language, 'en');
    assert.match(record.assistant_message, /Nothing is submitted until you approve/);
  });

  it('pauses at the consent gate without calling any tool, then resumes on consent', async () => {
    const token = await login();
    const record = await createCase(token, HOSPITAL_MESSAGE, false);
    const first = graphRuns(record)[0];
    assert.deepEqual(nodesOf(first), ['classifier', 'consent_gate']);
    assert.equal(first?.steps[1]?.status, 'paused');
    assert.equal(first?.outcome, 'awaiting_consent');
    assert.ok(first!.steps.every((step) => step.tools.length === 0));

    const resumed = await api()
      .post(`/api/cases/${record.case_id}/consents`)
      .set(bearer(token))
      .send({ purpose: 'prepare_resolution_options', granted: true });
    const second = graphRuns(resumed.body).at(-1);
    assert.equal(second?.trigger, 'consent_granted');
    assert.equal(nodesOf(second)[0], 'consent_gate');
    assert.equal(resumed.body.status, 'options_ready');
  });

  it('pauses the UPI journey for the customer and resumes after confirmation', async () => {
    const token = await login();
    const record = await createCase(token, UPI_MESSAGE);
    const first = graphRuns(record)[0];
    assert.deepEqual(nodesOf(first), ['classifier', 'consent_gate', 'context_retriever', 'transaction_auditor']);
    assert.equal(first?.outcome, 'awaiting_transaction');

    const candidate = record.pending_question!.candidates.find((item) => item.amount_inr === 8500)!;
    const confirmed = await api()
      .post(`/api/cases/${record.case_id}/transaction-confirmation`)
      .set(bearer(token))
      .send({ transaction_id: candidate.transaction_id, recognized: false });
    const second = graphRuns(confirmed.body).at(-1);
    assert.deepEqual(nodesOf(second), ['consent_gate', 'context_retriever', 'transaction_auditor', 'decision', 'explainer']);
    assert.match(second!.steps[2]!.summary, /signals:/);
    assert.equal(confirmed.body.status, 'options_ready');
  });

  it('routes a gateway denial to human review instead of failing the request', async () => {
    const principal: Principal = { sub: 'demo-customer-01', role: 'customer', display_name: 'Riya', scopes: [] };
    const record: CaseRecord = {
      case_id: 'SA-AGENT001',
      customer_id: 'demo-customer-01',
      event_type: 'hospitalization',
      urgency: 'high',
      status: 'intake',
      customer_message: HOSPITAL_MESSAGE,
      assistant_message: '',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      messages: [],
      consents: [{ purpose: 'prepare_resolution_options', status: 'granted', granted_at: '', revoked_at: null, actor: 'demo-customer-01' }],
      evidence: null,
      uploaded_documents: [],
      pending_question: null,
      decision: null,
      actions: [],
      timeline: [],
      ai_analysis: null,
    };
    insertCase(record);
    const result = await runAgent(record, principal, 'consent_granted');
    assert.match(result.error ?? '', /scope/i);
    assert.deepEqual(result.visited, ['consent_gate', 'context_retriever', 'human_review']);
    assert.equal(record.status, 'human_review');
    assert.equal(record.decision, null);
  });

  it('traces preparation and gateway-verified execution of an approved action', async () => {
    const token = await login();
    const record = await createCase(token);
    const option = record.decision!.options.find((candidate) => candidate.recommended)!;
    const prepared = await api().post(`/api/cases/${record.case_id}/actions`).set(bearer(token)).send({ option_id: option.option_id });
    const action = prepared.body.actions.at(-1);
    assert.equal(graphRuns(prepared.body).at(-1)?.steps[0]?.node, 'action_preparer');

    const approved = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    const tracker = graphRuns(approved.body).at(-1)?.steps[0];
    assert.equal(tracker?.node, 'action_tracker');
    assert.deepEqual(tracker?.tools, action.payload.steps.map((step: { tool: string }) => step.tool));

    await waitFor(async () => {
      const latest = await api().get(`/api/cases/${record.case_id}`).set(bearer(token));
      return latest.body.status === 'resolved';
    });
  });

  it('publishes the graph shape for the UI', async () => {
    const token = await login();
    const response = await api().get('/api/agent/graph').set(bearer(token));
    assert.equal(response.status, 200);
    assert.equal(response.body.engine, 'langgraph.js');
    assert.ok(response.body.nodes.some((item: { id: string }) => item.id === 'bill_auditor'));
    assert.match(response.body.mermaid, /consent_gate/);
  });

  it('detects Hinglish only with multiple markers', () => {
    assert.equal(detectLanguage('Papa hospital mein hain. Bill INR 80,000 hai.'), 'hinglish');
    assert.equal(detectLanguage('Papa is in hospital and the bill is INR 80,000.'), 'en');
  });
});
