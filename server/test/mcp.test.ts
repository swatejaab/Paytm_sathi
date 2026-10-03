import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { settings } from '../src/config';
import type { CaseRecord } from '../src/types';
import { api, app, bearer, createCase, login } from './helpers';

describe('partner MCP servers', () => {
  let baseUrl = '';
  let close: () => void = () => undefined;

  before(async () => {
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    close = () => server.close();
  });
  after(() => close());

  it('serves a standard contract over Streamable HTTP to any MCP client', async () => {
    const client = new Client({ name: 'test-inspector', version: '1.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp/lender`), {
        requestInit: { headers: { Authorization: `Bearer ${settings.mcpPartnerToken}`, 'x-saathi-customer': 'demo-customer-01' } },
      }),
    );
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    assert.ok(tools.includes('lending.get_kfs') && tools.includes('lending.submit_application'));
    const kfs = await client.callTool({
      name: 'lending.get_kfs',
      arguments: { case_id: 'SA-TEST0001', offer_id: 'OFFER-GAP-3M', amount_inr: 15000 },
    });
    const result = (kfs.structuredContent as { result: Record<string, number> }).result;
    assert.equal(result.principal_inr, 15000);
    assert.equal(result.cooling_off_days, 3);
    assert.ok(result.total_payable_inr! > 15000);
    await client.close();
  });

  it('rejects partner calls without the partner token', async () => {
    const response = await fetch(`${baseUrl}/mcp/payments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    assert.equal(response.status, 401);
  });

  it('binds the lender Key Fact Statement into the approval payload', async () => {
    const token = await login();
    const record = await createCase(token);
    const prepared = await api().post(`/api/cases/${record.case_id}/actions`).set(bearer(token)).send({ option_id: 'claim_plus_gap_plan' });
    const action = (prepared.body as CaseRecord).actions.at(-1)!;
    const kfs = action.payload.kfs?.[0] as Record<string, unknown> | undefined;
    assert.equal(kfs?.principal_inr, 15000);
    assert.equal(kfs?.offer_id, 'OFFER-GAP-3M');
    assert.ok(action.payload.steps.some((step) => step.tool === 'payments.create_link' && step.amount_inr === 10000));
  });

  it('records Account Aggregator consent in the context step and a CRM ticket on handoff', async () => {
    const token = await login();
    const record = await createCase(token);
    const context = record.agent_runs![0]!.steps.find((step) => step.node === 'context_retriever')!;
    assert.deepEqual(context.tools, ['payments.get_balance', 'aa.request_consent', 'aa.fetch_fi_data']);
    assert.match(context.summary, /AA consent AA-CN-/);

    const prepared = await api().post(`/api/cases/${record.case_id}/actions`).set(bearer(token)).send({ option_id: 'human_support' });
    const action = (prepared.body as CaseRecord).actions.at(-1)!;
    const approved = await api()
      .post(`/api/cases/${record.case_id}/actions/${action.action_id}/approve`)
      .set(bearer(token))
      .send({ payload_hash: action.payload_hash, confirm: true });
    assert.equal(approved.body.status, 'human_review');
    assert.match(approved.body.actions.at(-1).partner_requests[0].reference, /^HND-/);
  });
});
