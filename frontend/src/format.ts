import type { CaseStatus, EventType, Fact, GoalType } from './types';

export const inr = (amount: number): string =>
  `${amount < 0 ? '−' : ''}₹${Math.abs(Math.round(amount)).toLocaleString('en-IN')}`;

// Axis and KPI shorthand: ₹1.2L, ₹45K, ₹2.1Cr.
export function inrCompact(amount: number): string {
  const sign = amount < 0 ? '−' : '';
  const value = Math.abs(amount);
  if (value >= 10_000_000) return `${sign}₹${trim(value / 10_000_000)}Cr`;
  if (value >= 100_000) return `${sign}₹${trim(value / 100_000)}L`;
  if (value >= 1_000) return `${sign}₹${trim(value / 1_000)}K`;
  return `${sign}₹${Math.round(value)}`;
}
const trim = (value: number) => (value >= 100 ? Math.round(value).toString() : value.toFixed(1).replace(/\.0$/, ''));

export function dateTime(iso: string): string {
  return new Date(iso).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}

export function timeOnly(iso: string): string {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export function shortDate(date: string): string {
  return new Date(`${date.slice(0, 10)}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} d ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
}

export const EVENT_LABELS: Record<EventType, string> = {
  hospitalization: 'Hospital bill',
  upi_dispute: 'Unrecognised UPI payment',
  emi_shortfall: 'EMI payment problem',
  failed_refund: 'Failed payment refund',
  protection: 'Life insurance check',
  general_financial_support: 'Money question',
};

export const STATUS_LABELS: Record<CaseStatus, string> = {
  intake: 'Getting details',
  understand: 'Understanding',
  evidence_ready: 'Facts ready',
  options_ready: 'Options ready',
  awaiting_approval: 'Needs your approval',
  in_progress: 'In progress',
  resolved: 'Resolved',
  human_review: 'With a specialist',
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

export const GOAL_LABELS: Record<GoalType, string> = {
  emergency_fund: 'Emergency Fund',
  home: 'Home',
  vehicle: 'Vehicle',
  education: 'Education',
  wedding: 'Wedding',
  travel: 'Travel',
  retirement: 'Retirement',
  debt_repayment: 'Debt Repayment',
  custom: 'Custom',
};

export function factValue(fact: Fact): string {
  if (typeof fact.value === 'number' && fact.unit === 'INR') return inr(fact.value);
  if (typeof fact.value === 'boolean') return fact.value ? 'Yes' : 'No';
  if (fact.name === 'occurred_at' && typeof fact.value === 'string') return dateTime(fact.value);
  return String(fact.value);
}

const SOURCE_TYPES: Record<string, string> = {
  customer_statement: 'You told Saathi',
  bill_line: 'Your bill',
  policy_clause: 'Policy',
  customer_profile: 'Account records',
  calculation: 'Calculation',
  transaction: 'Transaction record',
  loan_account: 'Loan account',
  playbook: 'Saathi playbook',
  lender_offer: 'Lender offer (sample)',
  document_checklist: 'Claim checklist',
  regulation: 'Regulation',
  salary_schedule: 'Salary schedule',
};

export const sourceTypeLabel = (type: string): string => SOURCE_TYPES[type] ?? type.replace(/_/g, ' ');

export function sourceLabel(source: Fact['source']): string {
  const ref = source.type === 'customer_profile' ? '' : source.ref;
  return [ref, source.document].filter(Boolean).join(' / ');
}

export function describeSource(source: Fact['source']): string {
  const detail = sourceLabel(source);
  if (source.type === 'customer_statement' && detail) return detail;
  return detail ? `${sourceTypeLabel(source.type)}: ${detail}` : sourceTypeLabel(source.type);
}

export const LANGUAGES: { code: string; label: string }[] = [
  { code: '', label: 'Auto (reply in the language I write)' },
  { code: 'en-IN', label: 'English' },
  { code: 'hi-IN', label: 'हिन्दी Hindi' },
  { code: 'bn-IN', label: 'বাংলা Bengali' },
  { code: 'ta-IN', label: 'தமிழ் Tamil' },
  { code: 'te-IN', label: 'తెలుగు Telugu' },
  { code: 'mr-IN', label: 'मराठी Marathi' },
  { code: 'gu-IN', label: 'ગુજરાતી Gujarati' },
  { code: 'kn-IN', label: 'ಕನ್ನಡ Kannada' },
  { code: 'ml-IN', label: 'മലയാളം Malayalam' },
  { code: 'pa-IN', label: 'ਪੰਜਾਬੀ Punjabi' },
  { code: 'od-IN', label: 'ଓଡ଼ିଆ Odia' },
];

export function readPref(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // preferences are a convenience only
  }
}
