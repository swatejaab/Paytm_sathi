import { createApp } from './app';
import { n8nConfigured, openaiAvailable, sarvamAvailable, settings } from './config';

const app = createApp();

app.listen(settings.port, settings.host, () => {
  console.log(`[saathi] API listening on http://${settings.host}:${settings.port}`);
  console.log(
    `[saathi] OpenAI: ${openaiAvailable() ? 'ready' : 'disabled'} | Sarvam: ${sarvamAvailable() ? 'ready' : 'disabled'} | ` +
      `Partner channel: ${n8nConfigured() ? 'n8n' : 'local simulated partner'}`,
  );
  if (settings.jwtSecretEphemeral) {
    console.warn('[saathi] JWT_SECRET_KEY is unset or a placeholder; using an ephemeral secret (sessions reset on restart).');
  }
});
