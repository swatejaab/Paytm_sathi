import { z } from 'zod';
import { hasConsent, newId } from '../caseStore';
import { assessCoverage, type CoverageBillLine } from '../coverage';
import { SCORE_ACTIONS, scoreReport, simulateAction, type ScoreAction } from '../credit';
import { calculateEmi, checkAffordability } from '../decision';
import { householdContext, termPremium } from '../insurance';
import { retrievePolicyClauses } from '../documents';
import { settings } from '../config';
import { fixtures, healthRecordsFor, offersFor, PARTNERS, type HospitalAdmission } from '../fixtures';
import { guidanceFor } from '../playbooks/registry';
import { buildTwin, investmentsFor } from '../twin';
import { buildPortfolio, PAN_PATTERN, panOnFile } from '../holdings';
import type { CaseRecord, ConsentPurpose, EventType, Principal } from '../types';
import { GatewayError } from './errors';

export type PolicyLookup =
  | { found: false }
  | {
      found: true;
      document_id: string;
      file_name: string;
      insurer: string;
      policy_name: string;
      insured_members: string[];
      cashless_network: string[];
      sum_insured_inr: number;
      room_rent_limit_per_day_inr: number;
      deductible_per_claim_inr: number;
      clauses: { clause_id: string; page: number; title: string; text: string }[];
    };

export type AdmissionLookup = { found: false } | ({ found: true } & Omit<HospitalAdmission, 'claim_documents'>);

export interface FiData {
  consent_handle: string;
  accounts: { masked_account: string; type: string; balance_inr: number }[];
  avg_monthly_inflow_inr: number;
  avg_monthly_outflow_inr: number;
  months_analysed: number;
  next_salary_date: string | null;
  scheduled_debits: { title: string; amount_inr: number; due_date: string }[];
  mutual_funds: { name: string; value_inr: number; source: string }[];
  source: string;
}

export type McpServer = 'identity' | 'insurer' | 'hospital' | 'payments' | 'lender' | 'aa' | 'crm' | 'bureau' | 'knowledge';

// Partner MCP servers only ever learn which customer a call is for; the case record and principal stay in Saathi.
export interface ToolContext {
  customer_id: string;
  principal?: Principal;
  caseRecord?: CaseRecord;
}

export interface ToolDefinition {
  name: string;
  server: McpServer;
  kind: 'read' | 'write';
  scope: string;
  consent: ConsentPurpose | null;
  description: string;
  fixture: string;
  input: z.ZodType<Record<string, unknown>>;
  handler: (context: ToolContext, input: any) => unknown;
}

const caseId = z.string().regex(/^SA-[A-Z0-9]{8}$/);
const inr = z.number().int().nonnegative().max(10_000_000);
const caseOnly = z.object({ case_id: caseId }).strict();
const READ_CONSENT: ConsentPurpose = 'prepare_resolution_options';

function profileFor(customerId: string) {
  const profile = fixtures.profiles[customerId];
  if (!profile) throw new GatewayError('not_found', 'No financial profile exists for this customer.');
  return profile;
}

function transactionsFor(customerId: string) {
  return fixtures.payments.accounts[customerId]?.transactions ?? [];
}

const submitted = (prefix: string, partner: string) => ({
  reference: newId(prefix, 6),
  partner,
  status: 'submitted',
  simulated: true,
});

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'auth.get_principal',
    server: 'identity',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Return the authenticated principal and scopes.',
    fixture: 'users.json',
    input: caseOnly,
    handler: ({ principal }) => ({ sub: principal!.sub, role: principal!.role, scopes: principal!.scopes }),
  },
  {
    name: 'consent.get_status',
    server: 'identity',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Return case-local consent records.',
    fixture: 'case store',
    input: caseOnly,
    handler: ({ caseRecord }) => ({
      consents: caseRecord!.consents,
      prepare_resolution_options: hasConsent(caseRecord!, READ_CONSENT),
    }),
  },
  {
    name: 'case.get_owner',
    server: 'identity',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Return the case owner.',
    fixture: 'case store',
    input: caseOnly,
    handler: ({ caseRecord }) => ({ case_id: caseRecord!.case_id, customer_id: caseRecord!.customer_id }),
  },
  {
    name: 'insurer.get_policy',
    server: 'insurer',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: "Return the customer's health policy on file with the insurer: members, sum insured, cashless network, and clauses.",
    fixture: 'sample_documents.json#customers.*.policy',
    input: caseOnly,
    handler: ({ customer_id }): PolicyLookup => {
      const { policy } = healthRecordsFor(customer_id);
      if (!policy) return { found: false };
      return {
        found: true,
        document_id: policy.document_id,
        file_name: policy.file_name,
        insurer: policy.insurer,
        policy_name: policy.policy_name,
        insured_members: policy.insured_members,
        cashless_network: policy.cashless_network,
        sum_insured_inr: policy.schedule.sum_insured_inr,
        room_rent_limit_per_day_inr: policy.schedule.room_rent_limit_per_day_inr,
        deductible_per_claim_inr: policy.schedule.deductible_per_claim_inr,
        clauses: policy.clauses.map(({ clause_id, page, title, text }) => ({ clause_id, page, title, text })),
      };
    },
  },
  {
    name: 'insurer.check_coverage',
    server: 'insurer',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Assess each bill line against the policy schedule (room limit, non-medical items, deductible) and estimate cover.',
    fixture: 'sample_documents.json#customers.*.policy',
    input: z
      .object({
        case_id: caseId,
        bill_total_inr: inr,
        lines: z
          .array(
            z
              .object({
                line: z.number().int().min(0).max(999),
                description: z.string().min(1).max(120),
                amount_inr: inr,
                days: z.number().int().min(1).max(365).optional(),
                non_medical_inr: inr.optional(),
              })
              .strict(),
          )
          .max(60)
          .optional(),
      })
      .strict(),
    handler: ({ customer_id }, input: { bill_total_inr: number; lines?: CoverageBillLine[] }) => {
      const { policy, admission } = healthRecordsFor(customer_id);
      if (!policy) throw new GatewayError('not_found', 'No health policy is on file for this customer.');
      const clause = policy.clauses.find((candidate) => candidate.clause_id === policy.coverage_clause_id)!;
      const lines = input.lines?.length ? input.lines : admission?.bill.lines;
      if (!lines?.length) throw new GatewayError('invalid_input', 'An itemised bill is needed to check coverage.');
      if (lines.reduce((sum, line) => sum + line.amount_inr, 0) !== input.bill_total_inr) {
        throw new GatewayError('invalid_input', 'Bill lines must add up to the bill total.');
      }
      const assessment = assessCoverage(lines, policy.schedule);
      return {
        estimated_coverage_inr: assessment.estimated_coverage_inr,
        assessment,
        clause_id: clause.clause_id,
        page: clause.page,
        confidence: policy.coverage_confidence,
        policy_document_id: policy.document_id,
        policy_file_name: policy.file_name,
        assumptions: policy.clauses
          .filter((candidate) => candidate.clause_id === '3.2')
          .map(({ clause_id, page, title }) => ({ clause_id, page, title })),
        note: 'Estimate from the policy on file; the insurer makes the coverage decision.',
      };
    },
  },
  {
    name: 'insurer.get_claim_checklist',
    server: 'insurer',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return required claim documents and what is still missing.',
    fixture: 'sample_documents.json#customers.*.admission.claim_documents',
    input: caseOnly,
    handler: ({ customer_id }) => {
      const { admission } = healthRecordsFor(customer_id);
      if (!admission) return { clause_id: null, page: null, required: [], available: [], missing: [] };
      return { ...admission.claim_documents, missing: admission.missing_documents };
    },
  },
  {
    name: 'hospital.get_bill',
    server: 'hospital',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: "Return the customer's current admission at a network hospital and its itemised bill or estimate.",
    fixture: 'sample_documents.json#customers.*.admission',
    input: caseOnly,
    handler: ({ customer_id }): AdmissionLookup => {
      const { admission } = healthRecordsFor(customer_id);
      if (!admission) return { found: false };
      const { claim_documents: _claim, missing_documents: missing, ...rest } = admission;
      return { found: true, ...rest, missing_documents: missing };
    },
  },
  {
    name: 'hospital.get_documents',
    server: 'hospital',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return documents the hospital has issued.',
    fixture: 'sample_documents.json#customers.*.admission.claim_documents',
    input: caseOnly,
    handler: ({ customer_id }) => {
      const { admission } = healthRecordsFor(customer_id);
      return { available: admission?.claim_documents.available ?? [], missing: admission?.missing_documents ?? [] };
    },
  },
  {
    name: 'payments.get_balance',
    server: 'payments',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return balance and cash-flow context for the case owner.',
    fixture: 'customer_profiles.json',
    input: caseOnly,
    handler: ({ customer_id }) => profileFor(customer_id),
  },
  {
    name: 'payments.list_transactions',
    server: 'payments',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'List recent transactions, optionally filtered by amount and direction.',
    fixture: 'payments.json',
    input: z
      .object({
        case_id: caseId,
        amount_inr: inr.optional(),
        direction: z.enum(['debit', 'credit']).optional(),
        status: z.enum(['success', 'failed_debited']).optional(),
        limit: z.number().int().min(1).max(20).optional(),
      })
      .strict(),
    handler: ({ customer_id }, input: { amount_inr?: number; direction?: string; status?: string; limit?: number }) =>
      transactionsFor(customer_id)
        .filter((transaction) => !input.direction || transaction.direction === input.direction)
        .filter((transaction) => !input.status || transaction.status === input.status)
        .filter((transaction) => !input.amount_inr || transaction.amount_inr === input.amount_inr)
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
        .slice(0, input.limit ?? 10),
  },
  {
    name: 'payments.get_transaction',
    server: 'payments',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return one transaction owned by the case customer.',
    fixture: 'payments.json',
    input: z.object({ case_id: caseId, transaction_id: z.string().min(3).max(40) }).strict(),
    handler: ({ customer_id }, input: { transaction_id: string }) => {
      const transaction = transactionsFor(customer_id).find(
        (candidate) => candidate.transaction_id === input.transaction_id,
      );
      if (!transaction) throw new GatewayError('not_found', 'Transaction not found for this customer.');
      return transaction;
    },
  },
  {
    name: 'lending.get_offers',
    server: 'lender',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return labeled sample offers that fit an amount.',
    fixture: 'lending_offers.json',
    input: z.object({ case_id: caseId, amount_inr: inr }).strict(),
    handler: ({ customer_id }, input: { amount_inr: number }) => ({
      partner: fixtures.lending.partner,
      rules: fixtures.lending.affordability_rules,
      offers: offersFor(customer_id).filter(
        (offer) => input.amount_inr >= offer.min_amount_inr && input.amount_inr <= offer.max_amount_inr,
      ),
      notice: 'Sample offers for illustration; no lender is connected, so terms are indicative.',
    }),
  },
  {
    name: 'lending.check_affordability',
    server: 'lender',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Check a monthly EMI against the affordability guardrail.',
    fixture: 'customer_profiles.json + lending_offers.json',
    input: z.object({ case_id: caseId, monthly_emi_inr: inr }).strict(),
    handler: ({ customer_id }, input: { monthly_emi_inr: number }) =>
      checkAffordability(profileFor(customer_id), input.monthly_emi_inr, fixtures.lending.affordability_rules),
  },
  {
    name: 'lending.get_loans',
    server: 'lender',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return active loans, upcoming EMIs, and the salary schedule for the case owner.',
    fixture: 'loans.json',
    input: caseOnly,
    handler: ({ customer_id }) => {
      const account = fixtures.loans.accounts[customer_id];
      if (!account) throw new GatewayError('not_found', 'No loan account exists for this customer.');
      return account;
    },
  },
  {
    name: 'lending.get_kfs',
    server: 'lender',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return the Key Fact Statement (rate, APR, fees, total payable, cooling-off) for an offer and amount.',
    fixture: 'lending_offers.json',
    input: z.object({ case_id: caseId, offer_id: z.string().max(40), amount_inr: inr.positive() }).strict(),
    handler: ({ customer_id }, input: { offer_id: string; amount_inr: number }) => {
      const offer = offersFor(customer_id).find((candidate) => candidate.offer_id === input.offer_id);
      if (!offer || input.amount_inr < offer.min_amount_inr || input.amount_inr > offer.max_amount_inr) {
        throw new GatewayError('not_found', 'No offer covers this amount.');
      }
      const emi = calculateEmi(input.amount_inr, offer.annual_rate_pct, offer.tenure_months);
      const fee = Math.round((input.amount_inr * offer.processing_fee_pct) / 100);
      const years = offer.tenure_months / 12;
      return {
        kfs_id: newId('KFS', 6),
        lender: fixtures.lending.partner,
        offer_id: offer.offer_id,
        product: offer.product,
        principal_inr: input.amount_inr,
        interest_rate_pct: offer.annual_rate_pct,
        approx_apr_pct: Math.round((((emi.total_interest_inr + fee) / input.amount_inr) / years) * 1000) / 10,
        tenure_months: offer.tenure_months,
        monthly_emi_inr: emi.emi_inr,
        total_interest_inr: emi.total_interest_inr,
        processing_fee_inr: fee,
        total_payable_inr: input.amount_inr + emi.total_interest_inr + fee,
        cooling_off_days: 3,
        disbursed_to: offer.disburse_to,
        grievance_contact: "The lender's nodal grievance officer (named in the lender's own KFS)",
        notice: 'Indicative Key Fact Statement; the regulated lender issues the binding KFS before you sign.',
      };
    },
  },
  {
    name: 'aa.request_consent',
    server: 'aa',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Create an Account Aggregator consent artefact for deposit and mutual fund data, scoped to this case.',
    fixture: 'simulated Account Aggregator',
    input: z
      .object({ case_id: caseId, purpose: z.string().min(3).max(80), fi_types: z.array(z.enum(['DEPOSIT', 'MUTUAL_FUNDS'])).min(1).max(2) })
      .strict(),
    handler: (_context, input: { purpose: string; fi_types: string[] }) => ({
      consent_handle: newId('AA-CN', 6),
      status: 'ACTIVE',
      purpose: input.purpose,
      fi_types: input.fi_types,
      data_life: '72h, deleted when the case closes',
      notice: 'Simulated Account Aggregator consent artefact.',
    }),
  },
  {
    name: 'aa.fetch_fi_data',
    server: 'aa',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Fetch deposit balances, average inflow, and debits scheduled before the next salary under an active AA consent artefact.',
    fixture: 'customer_profiles.json + twin.json + loans.json',
    input: z.object({ case_id: caseId, consent_handle: z.string().regex(/^AA-CN-[A-Z0-9]{6}$/) }).strict(),
    handler: ({ customer_id }, input: { consent_handle: string }): FiData => {
      const profile = profileFor(customer_id);
      const twin = buildTwin(customer_id, { audit: false });
      const salaryDate = twin?.before_salary.salary_date ?? null;
      return {
        consent_handle: input.consent_handle,
        accounts: [{ masked_account: `XXXX${profile.profile_id.slice(-2)}21`, type: 'SAVINGS', balance_inr: profile.account_balance_inr }],
        avg_monthly_inflow_inr: profile.monthly_income_inr,
        avg_monthly_outflow_inr: profile.monthly_essential_expenses_inr + profile.existing_emi_inr,
        months_analysed: 3,
        next_salary_date: salaryDate,
        scheduled_debits: (twin?.obligations ?? [])
          .filter((item) => item.direction === 'out' && salaryDate !== null && item.due_date < salaryDate)
          .map(({ title, amount_inr, due_date }) => ({ title, amount_inr, due_date })),
        mutual_funds: investmentsFor(customer_id)
          .filter((item) => item.kind === 'mutual_fund')
          .map(({ name, value_inr, source }) => ({ name, value_inr, source })),
        source: 'Simulated FIP data via Account Aggregator',
      };
    },
  },
  {
    name: 'aa.fetch_holdings',
    server: 'aa',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description:
      'Fetch every holding linked to the PAN: bank and FD balances via Account Aggregator, demat stocks (CDSL/NSDL) and mutual funds (CAMS/KFintech) via the consolidated account statement. Account-level: needs explicit consent.',
    fixture: 'holdings.json + twin.json + loans.json',
    input: z.object({ pan: z.string().regex(PAN_PATTERN) }).strict(),
    handler: ({ customer_id }, input: { pan: string }) => {
      const pan = panOnFile(customer_id);
      if (!pan) throw new GatewayError('not_found', 'No PAN-linked holdings exist for this customer.');
      if (pan !== input.pan) throw new GatewayError('invalid_input', 'This PAN does not match the one verified on your account.');
      return buildPortfolio(customer_id);
    },
  },
  {
    name: 'bureau.get_credit_report',
    server: 'bureau',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: "Soft-pull the customer's credit report and score (simulated bureau, 300-900). Account-level: needs explicit consent per request.",
    fixture: 'credit_reports.json',
    input: z.object({ purpose: z.enum(['self_check']) }).strict(),
    handler: ({ customer_id }) => {
      const report = fixtures.credit.reports[customer_id];
      if (!report) throw new GatewayError('not_found', 'No credit report exists for this customer.');
      return { bureau: fixtures.credit.bureau, soft_pull: true, report, ...scoreReport(report) };
    },
  },
  {
    name: 'bureau.simulate_score',
    server: 'bureau',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Estimate how one action would move the credit score, using the same transparent model.',
    fixture: 'credit_reports.json',
    input: z.object({ action: z.enum(Object.keys(SCORE_ACTIONS) as [ScoreAction, ...ScoreAction[]]) }).strict(),
    handler: ({ customer_id }, input: { action: ScoreAction }) => {
      const report = fixtures.credit.reports[customer_id];
      if (!report) throw new GatewayError('not_found', 'No credit report exists for this customer.');
      const before = scoreReport(report);
      const after = scoreReport(simulateAction(report, input.action));
      return {
        action: input.action,
        label: SCORE_ACTIONS[input.action],
        before: before.score,
        after: after.score,
        delta: after.score - before.score,
        band_after: after.band,
        changed: after.factors
          .map((factor) => ({ id: factor.id, label: factor.label, delta: Math.round(factor.points - before.factors.find((old) => old.id === factor.id)!.points) }))
          .filter((factor) => factor.delta !== 0),
      };
    },
  },
  {
    name: 'knowledge.search_policy',
    server: 'knowledge',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Retrieve cited policy clauses (local index; Cognee fallback).',
    fixture: 'sample_documents.json#customers.*.policy',
    input: z.object({ case_id: caseId, query: z.string().min(2).max(500), top_k: z.number().int().min(1).max(5).optional() }).strict(),
    handler: ({ customer_id }, input: { query: string; top_k?: number }) => retrievePolicyClauses(customer_id, input.query, input.top_k ?? 3),
  },
  {
    name: 'knowledge.get_clause',
    server: 'knowledge',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Return one policy clause by id.',
    fixture: 'sample_documents.json#customers.*.policy',
    input: z.object({ case_id: caseId, clause_id: z.string().min(1).max(10) }).strict(),
    handler: ({ customer_id }, input: { clause_id: string }) => {
      const clause = healthRecordsFor(customer_id).policy?.clauses.find((candidate) => candidate.clause_id === input.clause_id);
      if (!clause) throw new GatewayError('not_found', 'Clause not found.');
      return clause;
    },
  },
  {
    name: 'knowledge.search_playbook',
    server: 'knowledge',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Return the resolution playbook for an event type.',
    fixture: 'playbooks.json',
    input: z
      .object({
        case_id: caseId,
        event_type: z.enum(['hospitalization', 'upi_dispute', 'emi_shortfall', 'failed_refund', 'protection', 'general_financial_support']),
      })
      .strict(),
    handler: (_context, input: { event_type: EventType }) => guidanceFor(input.event_type),
  },
  {
    name: 'claim.submit',
    server: 'insurer',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Submit a claim packet to the (simulated) insurer.',
    fixture: 'simulated insurer adapter',
    input: z
      .object({
        case_id: caseId,
        policy_document_id: z.string().max(40),
        bill_document_id: z.string().max(40),
        claimed_amount_inr: inr,
        estimated_coverage_inr: inr,
        pending_documents: z.array(z.string().max(80)).max(10),
      })
      .strict(),
    handler: () => submitted('CLM', PARTNERS.insurer),
  },
  {
    name: 'hospital.request_document',
    server: 'hospital',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Ask the (simulated) hospital for a missing document.',
    fixture: 'simulated hospital adapter',
    input: z.object({ case_id: caseId, document: z.string().min(2).max(80) }).strict(),
    handler: () => submitted('DOCREQ', PARTNERS.hospital),
  },
  {
    name: 'lending.submit_application',
    server: 'lender',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Submit an application to the (simulated) lender adapter.',
    fixture: 'simulated lender adapter (Mochatrade placeholder)',
    input: z
      .object({
        case_id: caseId,
        offer_id: z.string().max(40),
        amount_inr: inr.positive(),
        tenure_months: z.number().int().min(1).max(60),
        disburse_to: z.enum(['hospital', 'customer']),
      })
      .strict(),
    handler: () => submitted('APP', PARTNERS.lender),
  },
  {
    name: 'lending.request_due_date_change',
    server: 'lender',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Ask the (simulated) lender to move an EMI due date.',
    fixture: 'simulated lender adapter (Mochatrade placeholder)',
    input: z
      .object({
        case_id: caseId,
        loan_id: z.string().min(3).max(40),
        current_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        requested_due_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        fee_inr: inr,
      })
      .strict(),
    handler: ({ customer_id }, input: { loan_id: string; current_due_date: string; requested_due_date: string; fee_inr: number }) => {
      const loan = fixtures.loans.accounts[customer_id]?.loans.find((candidate) => candidate.loan_id === input.loan_id);
      if (!loan || loan.next_due_date !== input.current_due_date || loan.due_date_shift.fee_inr !== input.fee_inr) {
        throw new GatewayError('invalid_input', 'The due-date request must match the customer loan and its published fee.');
      }
      return submitted('DDC', PARTNERS.lender);
    },
  },
  {
    name: 'payments.create_link',
    server: 'payments',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: "Create a Paytm payment link so the customer pays their own share straight to the payee (simulated).",
    fixture: 'simulated payments adapter',
    input: z
      .object({ case_id: caseId, amount_inr: inr.positive(), payee: z.enum(['hospital']), purpose: z.string().min(3).max(120) })
      .strict(),
    handler: () => {
      const reference = newId('PLINK', 6);
      return { reference, partner: PARTNERS.payments, link: `https://paytm.me/saathi/${reference.toLowerCase()}`, status: 'submitted', simulated: true };
    },
  },
  {
    name: 'hospital.request_cashless',
    server: 'hospital',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Ask the (simulated) hospital TPA desk to start a cashless pre-authorisation.',
    fixture: 'simulated hospital adapter',
    input: z.object({ case_id: caseId, policy_document_id: z.string().max(40), estimated_amount_inr: inr.positive() }).strict(),
    handler: () => submitted('CASHLESS', PARTNERS.hospital),
  },
  {
    name: 'crm.create_ticket',
    server: 'crm',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Open a Paytm Support ticket carrying the Resolution Passport reference.',
    fixture: 'simulated support CRM',
    input: z.object({ case_id: caseId, category: z.string().min(3).max(60), summary: z.string().min(3).max(300) }).strict(),
    handler: () => submitted('TKT', 'Paytm Support CRM (simulated)'),
  },
  {
    name: 'crm.handoff_to_agent',
    server: 'crm',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Hand the case and its Resolution Passport to a human specialist queue.',
    fixture: 'simulated support CRM',
    input: z.object({ case_id: caseId, queue: z.enum(['saathi_specialists']), priority: z.enum(['high', 'medium', 'low']) }).strict(),
    handler: () => submitted('HND', 'Paytm Support CRM (simulated)'),
  },
  {
    name: 'insurer.apply_term_plan',
    server: 'insurer',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Submit a term life proposal to the (simulated) insurer at the quoted premium.',
    fixture: 'simulated insurer adapter',
    input: z
      .object({
        case_id: caseId,
        sum_assured_inr: inr.min(1_000_000).max(50_000_000),
        term_years: z.number().int().min(10).max(40),
        annual_premium_inr: inr.positive(),
      })
      .strict(),
    handler: ({ customer_id }, input: { sum_assured_inr: number; annual_premium_inr: number }) => {
      const household = householdContext(customer_id);
      if (!household || input.sum_assured_inr % 500_000 !== 0) throw new GatewayError('invalid_input', 'Cover must be in steps of INR 5 lakh.');
      // The insurer re-quotes independently; the approved premium must match its own rate table.
      if (termPremium(input.sum_assured_inr, household.age) !== input.annual_premium_inr) {
        throw new GatewayError('invalid_input', 'The premium does not match the insurer quote. Prepare the plan again.');
      }
      return submitted('TRM', PARTNERS.insurer);
    },
  },
  {
    name: 'payments.raise_refund_trace',
    server: 'payments',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Ask the (simulated) payments partner to trace a failed debit and pay late-reversal compensation.',
    fixture: 'simulated payments adapter',
    input: z
      .object({ case_id: caseId, transaction_id: z.string().min(3).max(40), amount_inr: inr.positive(), compensation_inr: inr })
      .strict(),
    handler: ({ customer_id }, input: { transaction_id: string; amount_inr: number; compensation_inr: number }) => {
      const transaction = transactionsFor(customer_id).find((candidate) => candidate.transaction_id === input.transaction_id);
      if (!transaction || transaction.status !== 'failed_debited' || transaction.amount_inr !== input.amount_inr) {
        throw new GatewayError('invalid_input', 'A refund trace needs a failed debit of exactly this amount.');
      }
      // Re-derive the compensation ceiling independently of the playbook: INR 100 a day after T+1.
      const daysSince = Math.round(
        (Date.parse(`${settings.demoDate}T00:00:00Z`) - Date.parse(`${transaction.occurred_at.slice(0, 10)}T00:00:00Z`)) / 86_400_000,
      );
      if (input.compensation_inr > Math.max(daysSince - 1, 0) * 100) {
        throw new GatewayError('invalid_input', 'Requested compensation exceeds the regulatory INR 100 a day after T+1.');
      }
      return submitted('RTR', PARTNERS.payments);
    },
  },
  {
    name: 'payments.open_dispute',
    server: 'payments',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Open a dispute with the (simulated) payment network.',
    fixture: 'simulated payments adapter',
    input: z
      .object({
        case_id: caseId,
        transaction_id: z.string().min(3).max(40),
        amount_inr: inr.positive(),
        reason: z.enum(['unauthorized_upi_debit']),
      })
      .strict(),
    handler: ({ customer_id }, input: { transaction_id: string; amount_inr: number }) => {
      const transaction = transactionsFor(customer_id).find(
        (candidate) => candidate.transaction_id === input.transaction_id,
      );
      if (!transaction || transaction.amount_inr !== input.amount_inr) {
        throw new GatewayError('invalid_input', 'Dispute amount must match the customer transaction.');
      }
      return submitted('DSP', PARTNERS.payments);
    },
  },
  {
    name: 'payments.pause_upi',
    server: 'payments',
    kind: 'write',
    scope: 'action:execute',
    consent: READ_CONSENT,
    description: 'Temporarily pause UPI payments on the customer account and flag the payee (simulated).',
    fixture: 'simulated payments adapter',
    input: z
      .object({
        case_id: caseId,
        transaction_id: z.string().min(3).max(40),
        block_payee: z.boolean(),
      })
      .strict(),
    handler: ({ customer_id }, input: { transaction_id: string }) => {
      if (!transactionsFor(customer_id).some((candidate) => candidate.transaction_id === input.transaction_id)) {
        throw new GatewayError('invalid_input', 'The transaction must belong to the customer.');
      }
      return submitted('UPIPAUSE', PARTNERS.payments);
    },
  },
];

export const toolRegistry = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export function listToolCatalog() {
  return TOOL_DEFINITIONS.map(({ name, server, kind, scope, consent, description, fixture }) => ({
    name,
    server,
    transport: server === 'identity' ? 'in_saathi' : 'mcp',
    kind,
    scope,
    consent,
    description,
    fixture,
    approval_required: kind === 'write',
  }));
}
