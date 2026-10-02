import type { CaseStatus, EventType, Fact } from './types';

export const inr = (amount: number): string => `₹${Math.round(amount).toLocaleString('en-IN')}`;

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export const EVENT_LABELS: Record<EventType, string> = {
  hospitalization: 'Hospitalization',
  upi_dispute: 'Unrecognized UPI payment',
  emi_shortfall: 'EMI shortfall',
  general_financial_support: 'General support',
};

export const STATUS_LABELS: Record<CaseStatus, string> = {
  intake: 'Intake',
  understand: 'Understand',
  evidence_ready: 'Evidence ready',
  options_ready: 'Options ready',
  awaiting_approval: 'Awaiting approval',
  in_progress: 'In progress',
  resolved: 'Resolved',
  human_review: 'Human review',
};

export const STATUS_FLOW: CaseStatus[] = [
  'intake',
  'understand',
  'evidence_ready',
  'options_ready',
  'awaiting_approval',
  'in_progress',
  'resolved',
];

export function factValue(fact: Fact): string {
  if (typeof fact.value === 'number' && fact.unit === 'INR') return inr(fact.value);
  if (typeof fact.value === 'boolean') return fact.value ? 'Yes' : 'No';
  if (fact.name === 'occurred_at' && typeof fact.value === 'string') return dateTime(fact.value);
  return String(fact.value);
}

export function sourceLabel(source: Fact['source']): string {
  return [source.ref, source.document].filter(Boolean).join(' / ');
}
