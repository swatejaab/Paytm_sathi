import { z } from 'zod';
import { hasConsent, newId } from '../caseStore';
import { checkAffordability } from '../decision';
import { retrievePolicyClauses } from '../documents';
import { settings } from '../config';
import { fixtures, PARTNERS } from '../fixtures';
import { guidanceFor } from '../playbooks/registry';
import type { CaseRecord, ConsentPurpose, EventType, Principal } from '../types';
import { GatewayError } from './errors';

export type McpServer = 'identity' | 'insurer' | 'hospital' | 'payments' | 'lender' | 'knowledge';

export interface ToolContext {
  principal: Principal;
  caseRecord: CaseRecord;
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
  if (!profile) throw new GatewayError('not_found', 'No synthetic financial profile exists for this customer.');
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
    handler: ({ principal }) => ({ sub: principal.sub, role: principal.role, scopes: principal.scopes }),
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
      consents: caseRecord.consents,
      prepare_resolution_options: hasConsent(caseRecord, READ_CONSENT),
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
    handler: ({ caseRecord }) => ({ case_id: caseRecord.case_id, customer_id: caseRecord.customer_id }),
  },
  {
    name: 'insurer.get_policy',
    server: 'insurer',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return the policy document and its clauses.',
    fixture: 'sample_documents.json#policy',
    input: caseOnly,
    handler: () => {
      const { policy } = fixtures.documents;
      return { document_id: policy.document_id, file_name: policy.file_name, insurer: policy.insurer, clauses: policy.clauses };
    },
  },
  {
    name: 'insurer.check_coverage',
    server: 'insurer',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Estimate coverage for a bill total with the governing clause.',
    fixture: 'sample_documents.json#policy',
    input: z.object({ case_id: caseId, bill_total_inr: inr }).strict(),
    handler: (_context, input: { bill_total_inr: number }) => {
      const { policy } = fixtures.documents;
      const clause = policy.clauses.find((candidate) => candidate.clause_id === policy.coverage_clause_id)!;
      return {
        estimated_coverage_inr: Math.min(policy.estimated_coverage_inr, input.bill_total_inr),
        clause_id: clause.clause_id,
        page: clause.page,
        confidence: policy.coverage_confidence,
        policy_document_id: policy.document_id,
        policy_file_name: policy.file_name,
        assumptions: policy.clauses
          .filter((candidate) => candidate.clause_id === '3.2')
          .map(({ clause_id, page, title }) => ({ clause_id, page, title })),
        note: 'Synthetic estimate for the demo only; not an insurer coverage decision.',
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
    fixture: 'sample_documents.json#claim_documents',
    input: caseOnly,
    handler: () => ({ ...fixtures.documents.claim_documents, missing: fixtures.documents.missing_documents }),
  },
  {
    name: 'hospital.get_bill',
    server: 'hospital',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return the itemized hospital bill.',
    fixture: 'sample_documents.json#bill',
    input: caseOnly,
    handler: () => fixtures.documents.bill,
  },
  {
    name: 'hospital.get_documents',
    server: 'hospital',
    kind: 'read',
    scope: 'case:read',
    consent: READ_CONSENT,
    description: 'Return documents the hospital has issued.',
    fixture: 'sample_documents.json#claim_documents',
    input: caseOnly,
    handler: () => ({
      available: fixtures.documents.claim_documents.available,
      missing: fixtures.documents.missing_documents,
    }),
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
    handler: ({ caseRecord }) => profileFor(caseRecord.customer_id),
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
    handler: ({ caseRecord }, input: { amount_inr?: number; direction?: string; status?: string; limit?: number }) =>
      transactionsFor(caseRecord.customer_id)
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
    handler: ({ caseRecord }, input: { transaction_id: string }) => {
      const transaction = transactionsFor(caseRecord.customer_id).find(
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
    description: 'Return labeled synthetic offers that fit an amount.',
    fixture: 'lending_offers.json',
    input: z.object({ case_id: caseId, amount_inr: inr }).strict(),
    handler: (_context, input: { amount_inr: number }) => ({
      partner: fixtures.lending.partner,
      rules: fixtures.lending.affordability_rules,
      offers: fixtures.lending.offers.filter(
        (offer) => input.amount_inr >= offer.min_amount_inr && input.amount_inr <= offer.max_amount_inr,
      ),
      notice: 'Synthetic offers; no lender API is connected.',
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
    handler: ({ caseRecord }, input: { monthly_emi_inr: number }) =>
      checkAffordability(profileFor(caseRecord.customer_id), input.monthly_emi_inr, fixtures.lending.affordability_rules),
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
    handler: ({ caseRecord }) => {
      const account = fixtures.loans.accounts[caseRecord.customer_id];
      if (!account) throw new GatewayError('not_found', 'No synthetic loan account exists for this customer.');
      return account;
    },
  },
  {
    name: 'knowledge.search_policy',
    server: 'knowledge',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Retrieve cited policy clauses (local index; Cognee fallback).',
    fixture: 'sample_documents.json#policy',
    input: z.object({ case_id: caseId, query: z.string().min(2).max(500), top_k: z.number().int().min(1).max(5).optional() }).strict(),
    handler: (_context, input: { query: string; top_k?: number }) => retrievePolicyClauses(input.query, input.top_k ?? 3),
  },
  {
    name: 'knowledge.get_clause',
    server: 'knowledge',
    kind: 'read',
    scope: 'case:read',
    consent: null,
    description: 'Return one policy clause by id.',
    fixture: 'sample_documents.json#policy',
    input: z.object({ case_id: caseId, clause_id: z.string().min(1).max(10) }).strict(),
    handler: (_context, input: { clause_id: string }) => {
      const clause = fixtures.documents.policy.clauses.find((candidate) => candidate.clause_id === input.clause_id);
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
        event_type: z.enum(['hospitalization', 'upi_dispute', 'emi_shortfall', 'failed_refund', 'general_financial_support']),
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
    handler: ({ caseRecord }, input: { loan_id: string; current_due_date: string; requested_due_date: string; fee_inr: number }) => {
      const loan = fixtures.loans.accounts[caseRecord.customer_id]?.loans.find((candidate) => candidate.loan_id === input.loan_id);
      if (!loan || loan.next_due_date !== input.current_due_date || loan.due_date_shift.fee_inr !== input.fee_inr) {
        throw new GatewayError('invalid_input', 'The due-date request must match the customer loan and its published fee.');
      }
      return submitted('DDC', PARTNERS.lender);
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
    handler: ({ caseRecord }, input: { transaction_id: string; amount_inr: number; compensation_inr: number }) => {
      const transaction = transactionsFor(caseRecord.customer_id).find((candidate) => candidate.transaction_id === input.transaction_id);
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
    handler: ({ caseRecord }, input: { transaction_id: string; amount_inr: number }) => {
      const transaction = transactionsFor(caseRecord.customer_id).find(
        (candidate) => candidate.transaction_id === input.transaction_id,
      );
      if (!transaction || transaction.amount_inr !== input.amount_inr) {
        throw new GatewayError('invalid_input', 'Dispute amount must match the customer transaction.');
      }
      return submitted('DSP', PARTNERS.payments);
    },
  },
];

export const toolRegistry = new Map(TOOL_DEFINITIONS.map((tool) => [tool.name, tool]));

export function listToolCatalog() {
  return TOOL_DEFINITIONS.map(({ name, server, kind, scope, consent, description, fixture }) => ({
    name,
    server,
    kind,
    scope,
    consent,
    description,
    fixture,
    approval_required: kind === 'write',
  }));
}
