import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config';
import type { Playbook, Role, Transaction } from './types';

export interface BillLine {
  line: number;
  description: string;
  amount_inr: number;
}

export interface PolicyClause {
  clause_id: string;
  page: number;
  title: string;
  text: string;
  estimated_coverage_inr: number | null;
}

export interface SampleDocuments {
  fixture_id: string;
  demo_only: boolean;
  description: string;
  bill: {
    document_id: string;
    document_type: 'bill';
    file_name: string;
    page: number;
    currency: string;
    total_inr: number;
    lines: BillLine[];
  };
  policy: {
    document_id: string;
    document_type: 'policy';
    file_name: string;
    insurer: string;
    coverage_clause_id: string;
    coverage_confidence: number;
    clauses: PolicyClause[];
    estimated_coverage_inr: number;
  };
  claim_documents: { clause_id: string; page: number; required: string[]; available: string[] };
  missing_documents: string[];
  expected_calculation: Record<string, number>;
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
  kind: 'exact_gap' | 'personal' | 'bridge';
  product: string;
  annual_rate_pct: number;
  tenure_months: number;
  processing_fee_pct: number;
  min_amount_inr: number;
  max_amount_inr: number;
  disbursal_days: number;
  disburse_to: 'hospital' | 'customer';
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
  playbooks: readJson<{ playbooks: Playbook[] }>('playbooks.json').playbooks,
  loans: readJson<{ partner: string; accounts: Record<string, LoanContext> }>('loans.json'),
};

export const PARTNERS = {
  insurer: fixtures.documents.policy.insurer,
  hospital: 'Synthetic hospital records desk (demo)',
  lender: fixtures.lending.partner,
  payments: fixtures.payments.partner,
} as const;
