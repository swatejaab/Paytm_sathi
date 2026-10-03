import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runAgent } from '../src/agent/graph';
import { detectLanguage } from '../src/agent/explainer';
import { insertCase } from '../src/db';
import type { AgentRun, CaseRecord, Principal, Transaction } from '../src/types';
import { api, bearer, createCase, HOSPITAL_MESSAGE, login, RIYA, UPI_MESSAGE, waitFor } from './helpers';

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
    assert.deepEqual(toolsByNode.policy_rag, ['insurer.get_policy', 'knowledge.search_policy']);
    assert.deepEqual(toolsByNode.bill_auditor, ['insurer.check_coverage'], "the hospital's itemised bill is checked against the policy");
    assert.ok(toolsByNode.decision!.includes('lending.get_offers'));
    assert.equal(record.status, 'options_ready');
    assert.deepEqual(record.decision?.calculation && {
      bill: record.decision.calculation.bill_total_inr,
      cover: record.decision.calculation.coverage_estimate_inr,
      pay: record.decision.calculation.customer_contribution_inr,
      gap: record.decision.calculation.exact_gap_inr,
    }, { bill: 80000, cover: 55000, pay: 10000, gap: 15000 });
  });

  it("fetches Neha's policy, hospital bill and bank data through MCP instead of asking", async () => {
    const token = await login();
    const record = await createCase(token, 'My father is in the ICU and the hospital wants a deposit of ₹80,000. What should I do?');
    assert.equal(record.language, 'en');
    assert.equal(record.context?.records?.policy?.policy_name, 'Family health floater');
    assert.equal(record.context?.records?.admission?.hospital, 'City Hospital, Thane');
    assert.equal(record.confirmed_bill?.document_name, 'City Hospital, Thane admission estimate');
    assert.equal(record.context?.slots.self_pay_inr?.source, 'account_records');
    assert.match(record.context!.slots.self_pay_inr!.ref, /Bank balance ₹38,420 - Rent ₹22,000 \(7 Oct\) - Paytm credit card bill ₹6,420 \(8 Oct\), before salary on 10 Oct/);
    const reply = record.assistant_message;
    assert.match(reply, /^I checked your Family health floater with the insurer, City Hospital, Thane's bill for your father's ICU stay and your bank balance/);
    assert.match(reply, /Cashless covers ₹55,000\. You can pay ₹10,000 now\. The real gap is ₹15,000\./);
    assert.match(reply, /₹65,000 less borrowed than a full loan/);
    assert.doesNotMatch(reply, /Do you have health insurance|How much can you pay/);
    const best = record.decision!.options.find((option) => option.recommended)!;
    assert.equal(best.option_id, 'claim_plus_gap_plan');
    const ids = record.decision!.options.map((option) => option.option_id);
    for (const id of ['claim_plus_savings', 'claim_plus_redeem', 'full_bill_loan', 'wait_for_claim', 'human_support']) assert.ok(ids.includes(id), id);
    assert.ok(record.decision!.warnings.some((warning) => /Room-rent cap \(policy clause 3\.2\): ₹15,000/.test(warning)));
    assert.ok(record.decision!.warnings.some((warning) => /discharge summary/.test(warning)));
    assert.deepEqual(record.evidence?.missing_documents, ['Discharge summary']);
    assert.ok(record.timeline.some((entry) => entry.title === 'Records checked with your consent'));
  });

  it("plans Arjun's surgery from his own records: cover and his balance leave no gap", async () => {
    const token = await login('demo-customer-02', '1357');
    const record = await createCase(token, 'I am admitted for surgery and the hospital estimate is ₹1.2 lakh.');
    assert.equal(record.decision?.calculation?.coverage_estimate_inr, 107000);
    assert.equal(record.decision?.calculation?.customer_contribution_inr, 21000);
    assert.equal(record.decision?.calculation?.exact_gap_inr, 0);
    assert.equal(record.decision?.recommended_option_id, 'claim_and_pay');
  });

  it('asks which bill to use when the stated amount differs from the hospital record', async () => {
    const token = await login();
    let record = await createCase(token, 'Papa is admitted in hospital and the bill is ₹1,00,000.');
    assert.equal(record.context?.awaiting, 'bill_choice');
    assert.match(record.assistant_message, /City Hospital, Thane has a bill of ₹80,000 on record/);
    assert.equal(record.decision, null);
    const reply = await api().post('/api/chat').set(bearer(token)).send({ message: "Use the hospital's ₹80,000 bill", conversation_id: record.case_id });
    record = reply.body as CaseRecord;
    assert.equal(record.decision?.calculation?.exact_gap_inr, 15000);
    assert.ok(record.decision?.warnings.some((warning) => /You first mentioned ₹1,00,000/.test(warning)));
  });

  it('answers a Hinglish customer in Hinglish without inventing numbers', async () => {
    const token = await login();
    const record = await createCase(token, HOSPITAL_MESSAGE);
    assert.equal(record.language, 'hinglish');
    assert.match(record.assistant_message, /Sabse accha raasta/);
    assert.match(record.assistant_message, /₹15,000/);
    const amounts = record.assistant_message.match(/₹[\d,]+/g) ?? [];
    const known = new Set(
      [80000, 55000, 10000, 15000, ...(record.decision?.options.flatMap((option) => [option.metrics.monthly_emi_inr, option.metrics.borrow_inr]) ?? [])].map(
        (value) => `₹${value.toLocaleString('en-IN')}`,
      ),
    );
    for (const amount of amounts) assert.ok(known.has(amount), `${amount} was not produced by the decision service`);
  });

  it('asks only for what the records cannot answer', async () => {
    const token = await login(...RIYA);
    const record = await createCase(token, 'My father is admitted in hospital and the bill is INR 80,000. What should I do?');
    assert.equal(record.language, 'en');
    assert.match(record.assistant_message, /^I found your Family health floater with Insurer partner \(simulated\), with a sum insured of ₹5,00,000\./);
    assert.equal(record.context?.awaiting, 'insurance_cover_inr');
    assert.equal(record.context?.slots.self_pay_inr?.value, 0, "Riya's balance is already committed before salary");
    assert.equal(record.decision, null);
  });

  it('asks for consent in chat before calling any tool, then resumes on consent', async () => {
    const token = await login();
    const record = await createCase(token, HOSPITAL_MESSAGE, false);
    assert.deepEqual(graphRuns(record), [], 'no tool runs before consent');
    assert.equal(record.context?.awaiting, 'records_consent');
    assert.ok(record.messages.at(-1)?.quick_replies?.some((reply) => reply.send === 'Yes, allow access'));

    const resumed = await api()
      .post(`/api/cases/${record.case_id}/consents`)
      .set(bearer(token))
      .send({ purpose: 'prepare_resolution_options', granted: true });
    const run = graphRuns(resumed.body).at(-1);
    assert.equal(run?.trigger, 'intake');
    assert.equal(resumed.body.status, 'options_ready');
    assert.equal(resumed.body.decision.calculation.exact_gap_inr, 15000);
  });

  it('pauses the UPI journey for the customer and resumes after confirmation', async () => {
    const token = await login();
    const record = await createCase(token, UPI_MESSAGE);
    const first = graphRuns(record)[0];
    assert.deepEqual(nodesOf(first), ['classifier', 'consent_gate', 'context_retriever', 'transaction_auditor']);
    assert.equal(first?.outcome, 'awaiting_transaction');

    const candidate = (record.pending_question as { candidates: Transaction[] }).candidates.find((item) => item.amount_inr === 8500)!;
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
