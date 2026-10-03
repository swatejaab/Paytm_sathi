import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import { settings } from '../config';
import { safeEqual } from '../hashing';
import { createPartnerServer, PARTNER_SERVERS } from '../mcp/servers';

// The simulated partner MCP servers over Streamable HTTP (stateless), so any MCP client, including
// MCP Inspector, can list and call them. Partners authenticate with a bearer token; the customer for a
// call comes from _meta.customer_id or the x-saathi-customer header.
export const mcpRouter = Router();

type PartnerId = (typeof PARTNER_SERVERS)[number];

mcpRouter.post('/mcp/:server', async (req, res) => {
  const server = String(req.params.server) as PartnerId;
  if (!PARTNER_SERVERS.includes(server)) {
    res.status(404).json({ jsonrpc: '2.0', error: { code: -32601, message: 'Unknown MCP server' }, id: null });
    return;
  }
  const [scheme, token] = String(req.headers.authorization ?? '').split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || !safeEqual(token, settings.mcpPartnerToken)) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Partner token required' }, id: null });
    return;
  }
  const customer = String(req.headers['x-saathi-customer'] ?? '').trim() || undefined;
  const mcp = createPartnerServer(server, customer);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

mcpRouter.all('/mcp/:server', (_req, res) => {
  res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Stateless server: use POST' }, id: null });
});
