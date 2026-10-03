export type Role = 'customer' | 'support';

export interface Principal {
  sub: string;
  role: Role;
  display_name: string;
  scopes: string[];
}

export type CaseStatus =
  | 'intake'
  | 'understand'
  | 'evidence_ready'
  | 'options_ready'
  | 'awaiting_approval'
  | 'in_progress'
  | 'resolved'
  | 'human_review';

export type EventType = 'hospitalization' | 'upi_dispute' | 'emi_shortfall' | 'failed_refund' | 'protection' | 'general_financial_support';
export type Urgency = 'high' | 'medium' | 'low';
export type RiskLevel = 'low' | 'medium' | 'high';
export type ConsentPurpose = 'prepare_resolution_options';
export type Actor = 'customer' | 'saathi' | 'partner' | 'support' | 'system';

export interface SourceRef {
  type:
    | 'policy_clause'
    | 'bill_line'
    | 'customer_profile'
    | 'transaction'
    | 'calculation'
    | 'lender_offer'
    | 'customer_statement'
    | 'playbook'
    | 'document_checklist'
    | 'loan_account'
    | 'regulation'
    | 'salary_schedule';
  ref: string;
  document?: string | null;
}

export interface Fact {
  name: string;
  label: string;
  value: number | string | boolean;
  unit?: 'INR' | 'months' | null;
  source: SourceRef;
  confidence: number;
  assumption?: boolean;
  confirmed_by_customer?: boolean;
}

export interface Guardrail {
  rule: string;
  passed: boolean;
  blocking: boolean;
  detail: string;
}

export interface PlannedWrite {
  tool: string;
  partner: string;
  amount_inr: number;
  summary: string;
  input: Record<string, unknown>;
}

export interface OptionMetrics {
  borrow_inr: number;
  extra_cost_inr: number;
  monthly_emi_inr: number;
  time_to_funds_days: number;
  effort_steps: number;
  risk: RiskLevel;
}

export interface ResolutionOption {
  option_id: string;
  title: string;
  summary: string;
  steps: string[];
  metrics: OptionMetrics;
  scores: { cost: number; risk: number; time: number; effort: number; total: number };
  guardrails: Guardrail[];
  trade_offs: string[];
  writes: PlannedWrite[];
  handoff: boolean;
  self_serve: boolean;
  feasible: boolean;
  recommended: boolean;
}

export interface GapCalculation {
  bill_total_inr: number;
  coverage_estimate_inr: number;
  customer_contribution_inr: number;
  exact_gap_inr: number;
  formula: string;
}

export interface Decision {
  formula_version: string;
  computed_at: string;
  event_type: EventType;
  calculation: GapCalculation | null;
  facts: Fact[];
  options: ResolutionOption[];
  recommended_option_id: string | null;
  explanation: string;
  warnings: string[];
  requires_verification: boolean;
  commission_considered: false;
  weights: { cost: number; risk: number; time: number; effort: number };
  coverage_breakdown?: import('./coverage').CoverageAssessment | null;
}

export interface EvidencePassage {
  document_id: string;
  document_name: string;
  document_type: string;
  clause_id?: string;
  page: number;
  title?: string;
  text: string;
  score: number;
  estimated_coverage_inr?: number | null;
}

export interface EvidenceDocument {
  document_id: string;
  document_type: string;
  document_name: string;
  text: string;
}

export interface Transaction {
  transaction_id: string;
  direction: 'debit' | 'credit';
  amount_inr: number;
  counterparty: string;
  counterparty_vpa: string | null;
  channel: string;
  occurred_at: string;
  device: string;
  location: string;
  recognized_device: boolean;
  first_time_counterparty: boolean;
  prior_payments_to_counterparty: number;
  status: string;
}

export interface Playbook {
  playbook_id: string;
  event_type: EventType;
  title: string;
  source: string;
  steps: string[];
}

export interface CaseEvidence {
  demo_only: boolean;
  fixture_id?: string;
  documents: EvidenceDocument[];
  retrieved_evidence: EvidencePassage[];
  missing_documents: string[];
  transaction?: Transaction | null;
  playbook?: Playbook | null;
  notice: string;
}

export interface UploadedDocument {
  document_id: string;
  document_type: 'bill' | 'policy';
  document_name: string;
  content_type: string;
  page_count: number;
  text: string;
  uploaded_at: string;
}

export interface ConsentRecord {
  purpose: ConsentPurpose;
  status: 'granted' | 'revoked';
  granted_at: string;
  revoked_at: string | null;
  actor: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  original?: string;
  language?: string;
  source?: 'saathi' | 'openai';
}

export interface TimelineEntry {
  at: string;
  status: CaseStatus;
  title: string;
  detail: string;
  actor: Actor;
}

export interface ParsedBillLine {
  line: number;
  description: string;
  amount_inr: number;
}

export type PendingQuestion =
  | { type: 'confirm_transaction'; prompt: string; candidates: Transaction[]; mode?: 'dispute' | 'select' }
  | {
      type: 'confirm_bill';
      prompt: string;
      document_id: string;
      document_name: string;
      total_inr: number;
      lines: ParsedBillLine[];
      reconciled: boolean;
    };

export interface ConfirmedBill {
  document_id: string;
  document_name: string;
  total_inr: number;
  lines: ParsedBillLine[];
  confirmed_at: string;
}

export interface SpecialistNote {
  at: string;
  author: string;
  text: string;
  to_customer: boolean;
}

export interface SpecialistDesk {
  assigned_to: string | null;
  assigned_name: string | null;
  assigned_at: string | null;
  verified_documents: boolean;
  notes: SpecialistNote[];
}

export type PartnerRequestStatus = 'submitted' | 'acknowledged' | 'completed' | 'failed';

export interface PartnerRequest {
  tool: string;
  partner: string;
  reference: string;
  amount_inr: number;
  summary: string;
  status: PartnerRequestStatus;
  updates: { at: string; status: PartnerRequestStatus; message: string }[];
}

export interface ActionPayloadStep {
  tool: string;
  partner: string;
  amount_inr: number;
  summary: string;
  input: Record<string, unknown>;
}

export interface ActionPayload {
  case_id: string;
  option_id: string;
  option_title: string;
  formula_version: string;
  prepared_for: string;
  steps: ActionPayloadStep[];
  handoff: boolean;
  passport: ResolutionPassport;
  kfs?: Record<string, unknown>[];
}

export type ActionStatus = 'awaiting_approval' | 'approved' | 'in_progress' | 'completed' | 'cancelled' | 'failed';

export interface CaseAction {
  action_id: string;
  option_id: string;
  title: string;
  status: ActionStatus;
  payload: ActionPayload;
  payload_hash: string;
  idempotency_key: string;
  channel: 'n8n' | 'local_mock' | null;
  created_at: string;
  approved_at: string | null;
  approved_by: string | null;
  partner_requests: PartnerRequest[];
}

export interface ResolutionPassport {
  passport_id: string;
  case_id: string;
  customer_id: string;
  event: { type: EventType; urgency: Urgency };
  story: string;
  facts: Fact[];
  calculation: GapCalculation | null;
  evidence_sources: { document_name: string; clause_id?: string; page: number; title?: string }[];
  documents: { document_name: string; document_type: string; origin: 'synthetic_fixture' | 'customer_upload' }[];
  missing_documents: string[];
  transaction: Transaction | null;
  recommended_option: string | null;
  consents: ConsentRecord[];
  notice: string;
}

export type Language = 'en' | 'hinglish';

export type AgentNodeId =
  | 'classifier'
  | 'consent_gate'
  | 'context_retriever'
  | 'policy_rag'
  | 'bill_auditor'
  | 'transaction_auditor'
  | 'emi_auditor'
  | 'decision'
  | 'explainer'
  | 'human_review'
  | 'action_preparer'
  | 'action_tracker';

export type AgentTrigger =
  | 'intake'
  | 'consent_granted'
  | 'transaction_confirmed'
  | 'documents_updated'
  | 'action_prepared'
  | 'action_approved';

export interface AgentStep {
  node: AgentNodeId;
  label: string;
  status: 'ok' | 'error' | 'paused';
  started_at: string;
  duration_ms: number;
  summary: string;
  tools: string[];
}

export interface AgentRun {
  run_id: string;
  trigger: AgentTrigger;
  graph: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  steps: AgentStep[];
}

export interface CaseRecord {
  case_id: string;
  customer_id: string;
  event_type: EventType;
  urgency: Urgency;
  language?: Language;
  preferred_language?: string;
  playbook_id?: string;
  // English rendering of a non-Latin message, used only for classification and amount rules.
  message_for_rules?: string;
  specialist?: SpecialistDesk;
  confirmed_bill?: ConfirmedBill | null;
  agent_runs?: AgentRun[];
  status: CaseStatus;
  customer_message: string;
  assistant_message: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  consents: ConsentRecord[];
  evidence: CaseEvidence | null;
  uploaded_documents: UploadedDocument[];
  pending_question: PendingQuestion | null;
  decision: Decision | null;
  actions: CaseAction[];
  timeline: TimelineEntry[];
  ai_analysis: Record<string, unknown> | null;
}
