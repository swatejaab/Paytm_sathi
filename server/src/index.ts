import { createApp } from './app';
import { n8nConfigured, openaiAvailable, sarvamAvailable, settings } from './config';

const app = createApp();

// Express 5 calls this callback with the error when binding fails (for example, the port is still in use).
const server = app.listen(settings.port, settings.host, (error?: Error) => {
  if (error) {
    console.error(`[saathi] Could not start on ${settings.host}:${settings.port}: ${error.message}`);
    process.exit(1);
  }
  console.log(`[saathi] API listening on http://${settings.host}:${settings.port}`);
  console.log(
    `[saathi] OpenAI: ${openaiAvailable() ? 'ready' : 'disabled'} | Sarvam: ${sarvamAvailable() ? 'ready' : 'disabled'} | ` +
      `Partner channel: ${n8nConfigured() ? 'n8n' : 'local simulated partner'}`,
  );
  console.log(
    `[saathi] Partner MCP servers: http://${settings.host}:${settings.port}/mcp/{insurer,hospital,payments,lender,aa,crm,knowledge}` +
      (settings.mcpPartnerTokenGenerated
        ? ` (local demo token: ${settings.mcpPartnerToken}; set MCP_PARTNER_TOKEN to pin it)`
        : ' (bearer token from MCP_PARTNER_TOKEN)'),
  );
  if (settings.jwtSecretEphemeral) {
    console.warn('[saathi] JWT_SECRET_KEY is unset or a placeholder; using an ephemeral secret (sessions reset on restart).');
  }
});

function shutdown(signal: string): void {
  console.log(`[saathi] ${signal} received; closing the server.`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
