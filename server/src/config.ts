import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(here, '..', '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
export const FRONTEND_DIST_DIR = path.join(ROOT_DIR, 'frontend', 'dist');

dotenv.config({ path: path.join(ROOT_DIR, '.env'), quiet: true });

const PLACEHOLDER_SECRET = 'replace-with-a-long-random-local-secret';

function readString(name: string, fallback = ''): string {
  return process.env[name]?.trim() || fallback;
}

function readBool(name: string, fallback = false): boolean {
  const raw = readString(name).toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function readInt(name: string, fallback: number): number {
  const value = Number.parseInt(readString(name), 10);
  return Number.isFinite(value) ? value : fallback;
}

const configuredJwtSecret = readString('JWT_SECRET_KEY');
const jwtSecretEphemeral = configuredJwtSecret.length < 32 || configuredJwtSecret === PLACEHOLDER_SECRET;

const generatedPartnerToken = crypto.randomBytes(18).toString('hex');

export interface Settings {
  host: string;
  trustProxy: boolean;
  port: number;
  frontendOrigins: string[];
  publicApiBaseUrl: string;
  databasePath: string;
  jwtSecret: string;
  jwtSecretEphemeral: boolean;
  jwtIssuer: string;
  jwtAudience: string;
  approvalAudience: string;
  accessTokenTtlSeconds: number;
  approvalTokenTtlSeconds: number;
  openaiEnabled: boolean;
  openaiApiKey: string;
  openaiModel: string;
  sarvamEnabled: boolean;
  sarvamApiKey: string;
  sarvamSttModel: string;
  sarvamTranslateModel: string;
  sarvamTtsModel: string;
  sarvamTtsSpeaker: string;
  n8nWebhookUrl: string;
  n8nWebhookSecret: string;
  mochaTradeApiUrl: string;
  mockPartnerDelayMs: number;
  loginAttemptsPerMinute: number;
  demoDate: string;
  mcpPartnerToken: string;
  cogneeEnabled: boolean;
  cogneeApiKey: string;
  cogneeBaseUrl: string;
  cogneeDataset: string;
  mcpPartnerTokenGenerated: boolean;
  maxDocumentBytes: number;
  maxAudioBytes: number;
}

export const settings: Settings = {
  host: readString('HOST', '127.0.0.1'),
  trustProxy: readBool('TRUST_PROXY'),
  port: readInt('PORT', 8000),
  frontendOrigins: readString('FRONTEND_ORIGINS', 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean),
  publicApiBaseUrl: readString('PUBLIC_API_BASE_URL', 'http://127.0.0.1:8000').replace(/\/+$/, ''),
  databasePath: readString('SAATHI_DB_PATH', path.join(DATA_DIR, 'saathi.sqlite3')),
  jwtSecret: jwtSecretEphemeral ? crypto.randomBytes(48).toString('hex') : configuredJwtSecret,
  jwtSecretEphemeral,
  jwtIssuer: 'paytm-saathi-api',
  jwtAudience: 'paytm-saathi-web',
  approvalAudience: 'saathi-mcp-gateway',
  accessTokenTtlSeconds: 30 * 60,
  approvalTokenTtlSeconds: 5 * 60,
  openaiEnabled: readBool('OPENAI_ENABLED'),
  openaiApiKey: readString('OPENAI_API_KEY'),
  openaiModel: readString('OPENAI_MODEL', 'gpt-4o-mini'),
  sarvamEnabled: readBool('SARVAM_ENABLED'),
  sarvamApiKey: readString('SARVAM_API_KEY'),
  sarvamSttModel: readString('SARVAM_STT_MODEL', 'saaras:v4'),
  sarvamTranslateModel: readString('SARVAM_TRANSLATE_MODEL', 'sarvam-translate:v1'),
  // Empty means Sarvam's current default voice model and speaker (older bulbul versions get retired).
  sarvamTtsModel: readString('SARVAM_TTS_MODEL'),
  sarvamTtsSpeaker: readString('SARVAM_TTS_SPEAKER'),
  n8nWebhookUrl: readString('N8N_WEBHOOK_URL'),
  n8nWebhookSecret: readString('N8N_WEBHOOK_SECRET'),
  mochaTradeApiUrl: readString('MOCHA_TRADE_API_URL'),
  mockPartnerDelayMs: readInt('MOCK_PARTNER_DELAY_MS', 3500),
  loginAttemptsPerMinute: readInt('LOGIN_ATTEMPTS_PER_MINUTE', 10),
  // "Today" for proactive alerts, pinned so the synthetic EMI due date stays two days away in every demo.
  demoDate: readString('DEMO_DATE', '2026-10-03'),
  mcpPartnerToken: readString('MCP_PARTNER_TOKEN') || generatedPartnerToken,
  cogneeEnabled: readBool('COGNEE_ENABLED'),
  cogneeApiKey: readString('COGNEE_API_KEY'),
  cogneeBaseUrl: readString('COGNEE_BASE_URL', 'https://api.cognee.ai').replace(/\/+$/, ''),
  cogneeDataset: readString('COGNEE_DATASET', 'saathi-knowledge'),
  mcpPartnerTokenGenerated: !readString('MCP_PARTNER_TOKEN'),
  maxDocumentBytes: 5 * 1024 * 1024,
  maxAudioBytes: 10 * 1024 * 1024,
};

export const openaiAvailable = (): boolean => settings.openaiEnabled && Boolean(settings.openaiApiKey);
export const sarvamAvailable = (): boolean => settings.sarvamEnabled && Boolean(settings.sarvamApiKey);
export const n8nConfigured = (): boolean => Boolean(settings.n8nWebhookUrl && settings.n8nWebhookSecret);
export const cogneeAvailable = (): boolean => settings.cogneeEnabled && Boolean(settings.cogneeApiKey && settings.cogneeBaseUrl);
