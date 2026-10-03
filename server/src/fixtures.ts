import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config';
import type { CoverageSchedule } from './coverage';
import type { CreditReport } from './credit';
import type { Role, Transaction } from './types';

export interface BillLine {
  line: number;
  description: string;
  amount_inr: number;
  days?: number;
  non_medical_inr?: number;
  note?: string;
}

export interface PolicyClause {
  clause_id: string;
  page: number;
  title: string;
  text: string;
  estimated_coverage_inr: number | null;
}

export interface HospitalBill {
  document_id: string;
  document_type: 'bill';
  file_name: string;
  page: number;
  currency: string;
  total_inr: number;
  lines: BillLine[];
}

export interface HealthPolicy {
  document_id: string;
  document_type: 'policy';
  file_name: string;
  insurer: string;
  policy_name: string;
  insured_members: string[];
  cashless_network: string[];
  coverage_clause_id: string;
  coverage_confidence: number;
  schedule: CoverageSchedule;
  clauses: PolicyClause[];
}

export interface HospitalAdmission {
  admission_id: string;
  hospital: string;
  patient: string;
  relation: string;
  ward: string;
  reason: string;
  admitted_at: string;
  cashless: boolean;
  bill: HospitalBill;
  claim_documents: { clause_id: string; page: number; required: string[]; available: string[] };
  missing_documents: string[];
}

export interface HealthRecords {
  policy: HealthPolicy | null;
  admission: HospitalAdmission | null;
}

interface SampleDocuments {
  fixture_id: string;
  demo_only: boolean;
  description: string;
  customers: Record<string, HealthRecords>;
}

export interface DemoUser {
  user_id: string;
  display_name: string;
  role: Role;
  passcode: string;
}

export interface FinancialProfile {
  profile_id: string;
  source: string;
  available_to_pay_inr: number;
  monthly_income_inr: number;
  monthly_essential_expenses_inr: number;
  existing_emi_inr: number;
  emergency_savings_inr: number;
  minimum_emergency_buffer_inr: number;
  account_balance_inr: number;
}

export interface LenderOffer {
  offer_id: string;
  kind: 'exact_gap' | 'personal' | 'bridge' | 'card_emi' | 'vehicle';
  product: string;
  annual_rate_pct: number;
  tenure_months: number;
  processing_fee_pct: number;
  min_amount_inr: number;
  max_amount_inr: number;
  disbursal_days: number;
  disburse_to: 'hospital' | 'customer';
  // Pre-approved offers are shown only to these customers; others are open to everyone.
  eligible_customers?: string[];
}

export interface LoanAccount {
  loan_id: string;
  product: string;
  emi_inr: number;
  next_due_date: string;
  outstanding_principal_inr: number;
  due_date_shift: { allowed: boolean; max_days: number; fee_inr: number };
  bounce_charge_inr: number;
  late_fee_inr_per_day: number;
}

export interface LoanContext {
  salary: { source: string; usual_credit_day: number; expected_date: string; amount_inr: number; status: 'credited' | 'delayed' };
  committed_before_due_inr: number;
  committed_note: string;
  loans: LoanAccount[];
}

export interface AffordabilityRules {
  max_total_emi_to_income: number;
  max_new_emi_share_of_free_cash: number;
}

function readJson<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')) as T;
}

export const fixtures = {
  documents: readJson<SampleDocuments>('sample_documents.json'),
  users: readJson<{ users: DemoUser[] }>('users.json').users,
  profiles: readJson<{ profiles: Record<string, FinancialProfile> }>('customer_profiles.json').profiles,
  lending: readJson<{ partner: string; affordability_rules: AffordabilityRules; offers: LenderOffer[] }>(
    'lending_offers.json',
  ),
  payments: readJson<{ partner: string; accounts: Record<string, { transactions: Transaction[] }> }>('payments.json'),
  loans: readJson<{ partner: string; accounts: Record<string, LoanContext> }>('loans.json'),
  credit: readJson<{ bureau: string; reports: Record<string, CreditReport> }>('credit_reports.json'),
};

export function healthRecordsFor(customerId: string): HealthRecords {
  return fixtures.documents.customers[customerId] ?? { policy: null, admission: null };
}

export function offersFor(customerId: string): LenderOffer[] {
  return fixtures.lending.offers.filter((offer) => !offer.eligible_customers || offer.eligible_customers.includes(customerId));
}

export const PARTNERS = {
  insurer: 'Insurer partner (simulated)',
  hospital: 'Hospital billing desk (simulated)',
  lender: fixtures.lending.partner,
  payments: fixtures.payments.partner,
} as const;
