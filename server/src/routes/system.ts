import { Router } from 'express';
import { requireAuth } from '../auth';
import { n8nConfigured, openaiAvailable, sarvamAvailable, settings } from '../config';
import { listToolCatalog } from '../mcp/tools';

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
    knowledge_backend: 'local_index',
    lender_adapter: settings.mochaTradeApiUrl ? 'mochatrade_unverified' : 'synthetic_fixture',
  });
});

systemRouter.get('/mcp/tools', requireAuth('tools:list'), (_req, res) => {
  res.json({ tools: listToolCatalog() });
});
