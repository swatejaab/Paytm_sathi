import { Router } from 'express';
import { requireAuth } from '../auth';
import { cogneeAvailable, n8nConfigured, openaiAvailable, sarvamAvailable, settings } from '../config';
import { graphMermaid } from '../agent/graph';
import { AGENT_NODES, GRAPH_VERSION } from '../agent/nodes';
import { partnerServerCatalog } from '../mcp/clients';
import { listToolCatalog } from '../mcp/tools';
import { playbookCatalog } from '../playbooks/registry';

export const systemRouter = Router();

systemRouter.get('/health', (_req, res) => {
  res.json({ status: 'ok', service: 'paytm-saathi-api', runtime: `node ${process.version}` });
});

systemRouter.get('/integrations/status', (_req, res) => {
  res.json({
    openai_available: openaiAvailable(),
    sarvam_available: sarvamAvailable(),
    n8n_configured: n8nConfigured(),
    partner_channel: n8nConfigured() ? 'n8n' : 'local_mock',
    knowledge_backend: cogneeAvailable() ? 'cognee' : 'local_index',
    lender_adapter: settings.mochaTradeApiUrl ? 'mochatrade_unverified' : 'synthetic_fixture',
  });
});

systemRouter.get('/mcp/tools', requireAuth('tools:list'), (_req, res) => {
  res.json({ tools: listToolCatalog() });
});

systemRouter.get('/agent/graph', requireAuth('tools:list'), (_req, res) => {
  res.json({ graph: GRAPH_VERSION, engine: 'langgraph.js', nodes: AGENT_NODES, mermaid: graphMermaid() });
});

systemRouter.get('/playbooks', requireAuth('tools:list'), (_req, res) => {
  res.json({ playbooks: playbookCatalog() });
});

systemRouter.get('/mcp/servers', requireAuth('tools:list'), (_req, res) => {
  res.json({ servers: partnerServerCatalog() });
});
