import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { DATA_DIR } from '../config';
import type { CaseRecord, EventType, Playbook, Urgency } from '../types';

// One case engine, many playbooks: each money problem is a YAML file that declares its triggers,
// the MCP tools it may use (the gateway grants nothing more), its rules engine, and its actions.

const PLAYBOOK_DIR = path.join(DATA_DIR, 'playbooks');
const EVENT_TYPES = ['hospitalization', 'upi_dispute', 'emi_shortfall', 'failed_refund', 'protection', 'general_financial_support'] as const;

const guardSchema = z.object({
  expr: z.string(),
  rule: z.string(),
  pass: z.string(),
  fail: z.string(),
  blocking: z.boolean().default(true),
});

const riskSchema = z.union([
  z.enum(['low', 'medium', 'high']),
  z.object({ expr: z.string(), true: z.enum(['low', 'medium', 'high']), false: z.enum(['low', 'medium', 'high']) }),
]);

const optionSchema = z.union([
  z.object({ specialist: z.literal(true), urgency: z.enum(['high', 'medium', 'low']).optional() }),
  z.object({
    id: z.string(),
    title: z.string(),
    summary: z.string(),
    steps: z.array(z.string()).default([]),
    guards: z.array(guardSchema).default([]),
    metrics: z.object({
      extra_cost_inr: z.union([z.number(), z.string()]).default(0),
      time_to_funds_days: z.number(),
      effort_steps: z.number(),
      risk: riskSchema,
    }),
    trade_offs: z.array(z.string()).default([]),
    writes: z
      .array(z.object({ tool: z.string(), amount: z.string(), summary: z.string(), input: z.record(z.string(), z.unknown()) }))
      .default([]),
    self_serve: z.boolean().default(false),
  }),
]);

export const playbookSchema = z.object({
  id: z.string().regex(/^[a-z0-9_]+$/),
  version: z.number().int(),
  title: z.string(),
  event_type: z.enum(EVENT_TYPES),
  urgency: z.enum(['high', 'medium', 'low']),
  priority: z.number(),
  triggers: z.object({ any: z.array(z.string()).default([]), weak: z.array(z.string()).default([]) }),
  engine: z.enum(['builtin:hospital_gap', 'builtin:upi_dispute', 'builtin:emi_shortfall', 'builtin:specialist', 'declarative']),
  auditor: z.enum(['bill_auditor', 'transaction_auditor', 'emi_auditor']).nullable(),
  pick_transaction: z
    .object({
      prompt: z.string(),
      mode: z.enum(['dispute', 'select']),
      filter: z.object({ direction: z.enum(['debit', 'credit']).optional(), status: z.string().optional() }).default({}),
      match_stated_amount: z.boolean().default(false),
    })
    .optional(),
  tools: z.object({ read: z.array(z.string()), write: z.array(z.string()) }),
  exit: z.string(),
  rules: z
    .object({
      version: z.string(),
      facts: z.array(
        z.object({
          name: z.string(),
          label: z.string(),
          expr: z.string(),
          unit: z.literal('INR').optional(),
          source: z.enum(['transaction', 'calculation', 'regulation', 'customer_profile']),
          ref: z.string().optional(),
        }),
      ),
    })
    .optional(),
  options: z.array(optionSchema).optional(),
  guidance: z.object({ title: z.string(), source: z.string(), steps: z.array(z.string()) }),
});

export type PlaybookDefinition = z.infer<typeof playbookSchema>;
export type DeclarativeOption = Exclude<NonNullable<PlaybookDefinition['options']>[number], { specialist: true }>;

function loadPlaybooks(): PlaybookDefinition[] {
  const files = fs.readdirSync(PLAYBOOK_DIR).filter((file) => file.endsWith('.yaml'));
  const playbooks = files.map((file) => {
    const parsed = playbookSchema.safeParse(parse(fs.readFileSync(path.join(PLAYBOOK_DIR, file), 'utf8')));
    if (!parsed.success) {
      throw new Error(`Invalid playbook ${file}: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`);
    }
    if (parsed.data.engine === 'declarative' && (!parsed.data.rules || !parsed.data.options)) {
      throw new Error(`Declarative playbook ${file} needs rules and options.`);
    }
    return parsed.data;
  });
  return playbooks.sort((a, b) => a.priority - b.priority);
}

export const PLAYBOOKS = loadPlaybooks();

// Identity and clause lookups are part of every case; everything else must be declared by the playbook.
export const BASELINE_TOOLS = new Set(['auth.get_principal', 'consent.get_status', 'case.get_owner', 'knowledge.get_clause']);

export function playbookById(id: string): PlaybookDefinition | undefined {
  return PLAYBOOKS.find((playbook) => playbook.id === id);
}

export function playbookForEvent(eventType: EventType): PlaybookDefinition {
  return (
    PLAYBOOKS.find((playbook) => playbook.event_type === eventType) ??
    PLAYBOOKS.find((playbook) => playbook.event_type === 'general_financial_support')!
  );
}

export function playbookForCase(record: Pick<CaseRecord, 'event_type' | 'playbook_id'>): PlaybookDefinition {
  return (record.playbook_id && playbookById(record.playbook_id)) || playbookForEvent(record.event_type);
}

export function classifyWithPlaybooks(message: string): { playbook: PlaybookDefinition; event_type: EventType; urgency: Urgency } {
  // "Emergency fund" is a savings question, not an emergency, so it never triggers the hospital journey.
  const normalized = message.toLowerCase().replace(/\b(?:emergency|emergancy)\s+(?:fund|savings?|corpus|kosh)\b/g, ' ');
  const has = (terms: string[]) => terms.some((term) => normalized.includes(term.toLowerCase()));
  const match = PLAYBOOKS.find((playbook) => has(playbook.triggers.any)) ?? PLAYBOOKS.find((playbook) => has(playbook.triggers.weak));
  const playbook = match ?? playbookForEvent('general_financial_support');
  return { playbook, event_type: playbook.event_type, urgency: playbook.urgency };
}

// True when the message names the situation directly rather than only hinting at it ("emergency", "papa").
export function namesSituation(playbook: PlaybookDefinition, message: string): boolean {
  const normalized = message.toLowerCase();
  return playbook.triggers.any.some((term) => normalized.includes(term.toLowerCase()));
}

export function toolAllowedByPlaybook(playbook: PlaybookDefinition, tool: string, kind: 'read' | 'write'): boolean {
  if (BASELINE_TOOLS.has(tool)) return true;
  return kind === 'write' ? playbook.tools.write.includes(tool) : playbook.tools.read.includes(tool);
}

export function guidanceFor(eventType: EventType): Playbook | null {
  const playbook = PLAYBOOKS.find((candidate) => candidate.event_type === eventType);
  if (!playbook) return null;
  return {
    playbook_id: `PB-${playbook.id.toUpperCase()}-${String(playbook.version).padStart(2, '0')}`,
    event_type: playbook.event_type,
    title: playbook.guidance.title,
    source: playbook.guidance.source,
    steps: playbook.guidance.steps,
  };
}

export function playbookCatalog() {
  return PLAYBOOKS.map((playbook) => ({
    id: playbook.id,
    version: playbook.version,
    title: playbook.title,
    event_type: playbook.event_type,
    engine: playbook.engine,
    triggers: playbook.triggers.any,
    tools: playbook.tools,
    exit: playbook.exit,
  }));
}
