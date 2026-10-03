import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { announceCaseUpdate } from './caseEvents';
import { settings } from './config';
import { HttpError } from './errors';
import type { CaseRecord } from './types';

let database: DatabaseSync | null = null;

function db(): DatabaseSync {
  if (database) return database;
  if (settings.databasePath !== ':memory:') {
    fs.mkdirSync(path.dirname(settings.databasePath), { recursive: true });
  }
  database = new DatabaseSync(settings.databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS cases (
      case_id TEXT PRIMARY KEY,
      customer_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_cases_customer ON cases (customer_id, updated_at);
    CREATE TABLE IF NOT EXISTS audit_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id TEXT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      event TEXT NOT NULL,
      tool TEXT,
      scope TEXT,
      decision TEXT NOT NULL,
      detail TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_events (case_id, id);
    CREATE TABLE IF NOT EXISTS user_preferences (
      user_id TEXT PRIMARY KEY,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS partner_events (
      event_id TEXT PRIMARY KEY,
      received_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS goals (
      goal_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goals_user ON goals (user_id, updated_at);
  `);
  return database;
}

export const nowIso = (): string => new Date().toISOString();

export function insertCase(record: CaseRecord): void {
  db()
    .prepare('INSERT INTO cases (case_id, customer_id, payload, updated_at) VALUES (?, ?, ?, ?)')
    .run(record.case_id, record.customer_id, JSON.stringify(record), record.updated_at);
}

export function findCase(caseId: string): CaseRecord | null {
  const row = db().prepare('SELECT payload FROM cases WHERE case_id = ?').get(caseId) as
    | { payload: string }
    | undefined;
  return row ? (JSON.parse(row.payload) as CaseRecord) : null;
}

export function updateCase(record: CaseRecord): void {
  record.updated_at = nowIso();
  const result = db()
    .prepare('UPDATE cases SET payload = ?, updated_at = ? WHERE case_id = ?')
    .run(JSON.stringify(record), record.updated_at, record.case_id);
  if (Number(result.changes) !== 1) throw new HttpError(404, 'Case not found');
  announceCaseUpdate(record.case_id);
}

export function deleteCase(caseId: string, customerId: string): boolean {
  const result = db().prepare('DELETE FROM cases WHERE case_id = ? AND customer_id = ?').run(caseId, customerId);
  return Number(result.changes) === 1;
}

export function listCases(customerId?: string): CaseRecord[] {
  const rows = (
    customerId
      ? db().prepare('SELECT payload FROM cases WHERE customer_id = ? ORDER BY updated_at DESC').all(customerId)
      : db().prepare('SELECT payload FROM cases ORDER BY updated_at DESC').all()
  ) as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload) as CaseRecord);
}

export interface AuditInput {
  case_id?: string | null;
  actor: string;
  event: string;
  tool?: string | null;
  scope?: string | null;
  decision?: 'allow' | 'deny' | 'info';
  detail?: Record<string, unknown>;
}

export interface AuditEvent extends Required<Omit<AuditInput, 'detail'>> {
  id: number;
  at: string;
  detail: Record<string, unknown>;
}

export function recordAudit(entry: AuditInput): void {
  db()
    .prepare(
      'INSERT INTO audit_events (case_id, at, actor, event, tool, scope, decision, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      entry.case_id ?? null,
      nowIso(),
      entry.actor,
      entry.event,
      entry.tool ?? null,
      entry.scope ?? null,
      entry.decision ?? 'info',
      JSON.stringify(entry.detail ?? {}),
    );
}

export function listAudit(caseId: string): AuditEvent[] {
  const rows = db()
    .prepare(
      'SELECT id, case_id, at, actor, event, tool, scope, decision, detail FROM audit_events WHERE case_id = ? ORDER BY id ASC',
    )
    .all(caseId) as unknown as (Omit<AuditEvent, 'detail'> & { detail: string })[];
  return rows.map((row) => ({ ...row, detail: JSON.parse(row.detail) as Record<string, unknown> }));
}

export function claimPartnerEvent(eventId: string): boolean {
  const result = db()
    .prepare('INSERT OR IGNORE INTO partner_events (event_id, received_at) VALUES (?, ?)')
    .run(eventId, nowIso());
  return Number(result.changes) === 1;
}

export interface StandingConsents {
  records: boolean;
  ai: boolean;
  voice: boolean;
}

export interface UserPreferences {
  alerts_enabled?: boolean;
  dismissed_alerts?: string[];
  goals_seeded?: boolean;
  // Choices the customer asked Saathi to remember; each is revocable and still recorded per case.
  consents?: Partial<StandingConsents>;
  holdings_link?: { pan_masked: string; linked_at: string };
}

export function standingConsents(userId: string): StandingConsents {
  const saved = getPreferences(userId).consents ?? {};
  return { records: Boolean(saved.records), ai: Boolean(saved.ai), voice: Boolean(saved.voice) };
}

export function getPreferences(userId: string): UserPreferences {
  const row = db().prepare('SELECT payload FROM user_preferences WHERE user_id = ?').get(userId) as { payload: string } | undefined;
  return row ? (JSON.parse(row.payload) as UserPreferences) : {};
}

export function savePreferences(userId: string, preferences: UserPreferences): void {
  db()
    .prepare('INSERT INTO user_preferences (user_id, payload) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload')
    .run(userId, JSON.stringify(preferences));
}

export function listGoalRows<T>(userId: string): T[] {
  const rows = db().prepare('SELECT payload FROM goals WHERE user_id = ? ORDER BY updated_at DESC').all(userId) as { payload: string }[];
  return rows.map((row) => JSON.parse(row.payload) as T);
}

export function upsertGoalRow<T extends { goal_id: string; user_id: string; updated_at: string }>(goal: T): void {
  db()
    .prepare(
      'INSERT INTO goals (goal_id, user_id, payload, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(goal_id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at',
    )
    .run(goal.goal_id, goal.user_id, JSON.stringify(goal), goal.updated_at);
}

export function deleteGoalRow(userId: string, goalId: string): boolean {
  return Number(db().prepare('DELETE FROM goals WHERE goal_id = ? AND user_id = ?').run(goalId, userId).changes) === 1;
}
