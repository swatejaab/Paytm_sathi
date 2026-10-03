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

export type QuickAction =
  | 'open_plan'
  | 'upload_bill'
  | 'upload_policy'
  | 'create_goal'
  | 'prepare_option'
  | 'secure_account'
  | 'handoff'
  | 'new_chat'
  | 'open_insights'
  | 'open_goals'
  | 'report_transaction';

// A tappable reply under an assistant message. "send" replies go through the normal chat pipeline as text.
export interface QuickReply {
  label: string;
  send?: string;
  action?: QuickAction;
  payload?: Record<string, unknown>;
}

export interface GapLine {
  label: string;
  amount_inr: number;
  op: '' | '-' | '=';
  source: string;
}

export interface GoalDraft {
  name: string;
  type: string;
  target_inr: number;
  target_date: string | null;
  current_savings_inr: number;
  monthly_contribution_inr: number | null;
}

export type ChatCard =
  | { type: 'gap'; lines: GapLine[]; formula: string }
  | { type: 'plan' }
  | { type: 'transactions' }
  | { type: 'bill_confirmation' }
  | { type: 'afford'; assessment: Record<string, unknown> }
  | { type: 'goal_draft'; goal: GoalDraft; required_monthly_inr: number | null; months_left: number | null };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  original?: string;
  language?: string;
  // For a customer message in an Indian language: the English Saathi worked from, shown so they can check it.
  understood?: string;
  source?: 'saathi' | 'openai';
  quick_replies?: QuickReply[];
  card?: ChatCard;
}

export type JourneyId =
  | 'hospital'
  | 'bill'
  | 'upi_fraud'
  | 'failed_refund'
  | 'emi'
  | 'protection'
  | 'afford'
  | 'goal'
  | 'specialist'
  | 'general';

export type SlotSource =
  | 'customer_statement'
  | 'uploaded_document'
  | 'account_records'
  | 'insurer_estimate'
  | 'insurer_record'
  | 'hospital_record'
  | 'customer_choice';

// What Saathi found through the partner MCP servers after consent, kept so later turns don't fetch again.
export interface FetchedRecords {
  checked_at: string;
  policy: {
    policy_name: string;
    insurer: string;
    document_id: string;
    file_name: string;
    sum_insured_inr: number;
    insured_members: string[];
    cashless_network: string[];
  } | null;
  admission: {
    admission_id: string;
    hospital: string;
    patient: string;
    relation: string;
    ward: string;
    reason: string;
    cashless: boolean;
    document_id: string;
    document_name: string;
    total_inr: number;
    lines: ParsedBillLine[];
    missing_documents: string[];
  } | null;
  cash: {
    balance_inr: number;
    next_salary_date: string | null;
    scheduled_debits: { title: string; amount_inr: number; due_date: string }[];
    safe_to_pay_inr: number;
    mutual_funds: { name: string; value_inr: number }[];
  } | null;
}

// One remembered value in a conversation, with where it came from. Unknown values are simply absent.
export interface Slot<T> {
  value: T;
  source: SlotSource;
  ref: string;
  confidence: number;
  updated_at: string;
}

export interface ContextSlots {
  bill_inr?: Slot<number>;
  has_insurance?: Slot<boolean>;
  insurance_cover_inr?: Slot<number>;
  policy_sum_insured_inr?: Slot<number>;
  self_pay_inr?: Slot<number>;
  emi_inr?: Slot<number>;
  emi_due_date?: Slot<string>;
  salary_date?: Slot<string>;
  debit_inr?: Slot<number>;
  purchase_inr?: Slot<number>;
  purchase_item?: Slot<string>;
}

export type AwaitingField =
  | 'bill_inr'
  | 'bill_kind'
  | 'bill_choice'
  | 'has_insurance'
  | 'insurance_cover_inr'
  | 'self_pay_inr'
  | 'records_consent'
  | 'amount_role'
  | 'purchase_inr'
  | 'goal_target'
  | 'goal_date'
  | 'ai_consent';

export interface ConversationContext {
  journey: JourneyId | null;
  slots: ContextSlots;
  awaiting: AwaitingField | null;
  // An amount the customer gave without saying what it was, kept until they clarify.
  unassigned_amount_inr?: number | null;
  // What the customer first said the bill was, kept for comparison after they confirm an uploaded bill.
  stated_bill_inr?: number | null;
  // The question to answer once the customer allows Saathi to read their records.
  after_consent?: 'plan' | 'afford' | 'goal' | 'spending' | 'cashflow' | null;
  records_consent_declined?: boolean;
  // A question waiting for the customer to allow AI answers, and whether they said no in this chat.
  pending_ai_question?: string | null;
  ai_declined?: boolean;
  records?: FetchedRecords | null;
  // The customer said the hospital's bill on record is not the bill they are asking about.
  hospital_bill_declined?: boolean;
  goal_draft?: Partial<GoalDraft> | null;
  missing: string[];
  gap: GapCalculation | null;
  updated_at: string;
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
  days?: number;
  non_medical_inr?: number;
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
  documents: { document_name: string; document_type: string; origin: 'customer_upload' }[];
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
  | 'details_updated'
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
  title?: string;
  // True once the customer renamed the conversation, so automatic titles stop.
  title_locked?: boolean;
  context?: ConversationContext;
  event_type: EventType;
  urgency: Urgency;
  language?: Language;
  preferred_language?: string;
  // 'detected' when Saathi switched to the language the customer wrote in, so it can switch back.
  language_source?: 'chosen' | 'detected';
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
