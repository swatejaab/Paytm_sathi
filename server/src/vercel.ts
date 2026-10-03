// Vercel serverless entry. scripts/vercel-build.mjs bundles this file into the function that serves /api and /mcp.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { waitUntil } from '@vercel/functions';
import { createApp } from './app';
import { openaiAvailable, sarvamAvailable, settings } from './config';
import { setBackgroundWaiter } from './background';

setBackgroundWaiter(waitUntil);

const app = createApp();

console.log(`[saathi] Vercel function ready | OpenAI: ${openaiAvailable() ? 'ready' : 'disabled'} | Sarvam: ${sarvamAvailable() ? 'ready' : 'disabled'}`);
if (settings.jwtSecretEphemeral) {
  console.warn('[saathi] JWT_SECRET_KEY is not set in Vercel; sessions will break whenever a new instance starts.');
}

export default function handler(req: IncomingMessage, res: ServerResponse): void {
  app(req, res);
}
