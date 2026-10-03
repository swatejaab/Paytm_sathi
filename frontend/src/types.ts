export type Role = 'customer' | 'support';
export type CaseStatus =
  | 'intake'
  | 'understand'
  | 'evidence_ready'
  | 'options_ready'
  | 'awaiting_approval'
  | 'in_progress'
  | 'resolved'
  | 'human_review';
export type EventType = 'hospitalization' | 'upi_dispute' | 'emi_shortfall' | 'failed_refund' | 'general_financial_support';
export type RiskLevel = 'low' | 'medium' | 'high';

export interface SessionUser {
  user_id: string;
  display_name: string;
  role: Role;
}

export interface Session {
  token: string;
  user: SessionUser;
  expires_at: number;
}

export interface IntegrationStatus {
  openai_available: boolean;
  sarvam_available: boolean;
  n8n_configured: boolean;
  partner_channel: 'n8n' | 'local_mock';
  knowledge_backend: string;
  lender_adapter: string;
}

export interface Fact {
  name: string;
  label: string;
  value: number | string | boolean;
  unit?: 'INR' | 'months' | null;
  source: { type: string; ref: string; document?: string | null };
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

export interface ResolutionOption {
  option_id: string;
  title: string;
  summary: string;
  steps: string[];
  metrics: {
    borrow_inr: number;
    extra_cost_inr: number;
    monthly_emi_inr: number;
    time_to_funds_days: number;
    effort_steps: number;
    risk: RiskLevel;
  };
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
}

export interface Playbook {
  playbook_id: string;
  title: string;
  source: string;
  steps: string[];
}

export interface UploadedDocument {
  document_id: string;
  document_type: 'bill' | 'policy';
  document_name: string;
  page_count: number;
  text: string;
  uploaded_at: string;
}

export interface ConsentRecord {
  purpose: string;
  status: 'granted' | 'revoked';
  granted_at: string;
  revoked_at: string | null;
}

export interface TimelineEntry {
  at: string;
  status: CaseStatus;
  title: string;
  detail: string;
  actor: 'customer' | 'saathi' | 'partner' | 'support' | 'system';
}

export interface PartnerRequest {
  tool: string;
  partner: string;
  reference: string;
  amount_inr: number;
  summary: string;
  status: 'submitted' | 'acknowledged' | 'completed' | 'failed';
  updates: { at: string; status: string; message: string }[];
}

export interface CaseAction {
  action_id: string;
  option_id: string;
  title: string;
  status: 'awaiting_approval' | 'approved' | 'in_progress' | 'completed' | 'cancelled' | 'failed';
  payload: {
    steps: PlannedWrite[];
    handoff: boolean;
    passport: { passport_id: string };
    formula_version: string;
    kfs?: KeyFactStatement[];
  };
  payload_hash: string;
  channel: 'n8n' | 'local_mock' | null;
  created_at: string;
  approved_at: string | null;
  partner_requests: PartnerRequest[];
}

export interface AiAnalysis {
  summary: string;
  observations?: string[];
  missing_information?: string[];
  follow_up_questions?: string[];
  model?: string;
}

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
  trigger: string;
  graph: string;
  started_at: string;
  finished_at: string | null;
  outcome: string;
  steps: AgentStep[];
}

export interface AgentNodeInfo {
  id: AgentNodeId;
  label: string;
  responsibility: string;
  decides_money: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  original?: string;
  language?: string;
  source?: 'saathi' | 'openai';
}

export interface CaseRecord {
  case_id: string;
  customer_id: string;
  event_type: EventType;
  urgency: 'high' | 'medium' | 'low';
  language?: 'en' | 'hinglish';
  preferred_language?: string;
  playbook_id?: string;
  agent_runs?: AgentRun[];
  status: CaseStatus;
  customer_message: string;
  created_at: string;
  updated_at: string;
  messages: ChatMessage[];
  consents: ConsentRecord[];
  evidence: {
    demo_only: boolean;
    documents: { document_name: string; document_type: string }[];
    retrieved_evidence: EvidencePassage[];
    missing_documents: string[];
    transaction?: Transaction | null;
    playbook?: Playbook | null;
    notice: string;
  } | null;
  uploaded_documents: UploadedDocument[];
  pending_question:
    | { type: 'confirm_transaction'; prompt: string; candidates: Transaction[]; mode?: 'dispute' | 'select' }
    | {
        type: 'confirm_bill';
        prompt: string;
        document_id: string;
        document_name: string;
        total_inr: number;
        lines: { line: number; description: string; amount_inr: number }[];
        reconciled: boolean;
      }
    | null;
  specialist?: {
    assigned_to: string | null;
    assigned_name: string | null;
    assigned_at: string | null;
    verified_documents: boolean;
    notes: { at: string; author: string; text: string; to_customer: boolean }[];
  };
  confirmed_bill?: { document_id: string; document_name: string; total_inr: number } | null;
  decision: Decision | null;
  actions: CaseAction[];
  timeline: TimelineEntry[];
  ai_analysis: AiAnalysis | null;
}

export interface CaseSummary {
  case_id: string;
  customer_id: string;
  event_type: EventType;
  urgency: string;
  status: CaseStatus;
  customer_message: string;
  recommended_option: string | null;
  created_at: string;
  updated_at: string;
}

export interface EvidenceResponse {
  demo_only: boolean;
  documents: { document_id?: string; document_name: string; document_type: string; text?: string; page_count?: number }[];
  retrieved_evidence: EvidencePassage[];
  missing_documents: string[];
  calculation: GapCalculation | null;
  transaction: Transaction | null;
  playbook: Playbook | null;
  notice: string;
}

export interface Passport {
  passport_id: string;
  case_id: string;
  event: { type: EventType; urgency: string };
  story: string;
  facts: Fact[];
  calculation: GapCalculation | null;
  evidence_sources: { document_name: string; clause_id?: string; page: number; title?: string }[];
  documents: { document_name: string; document_type: string; origin: string }[];
  missing_documents: string[];
  transaction: Transaction | null;
  recommended_option: string | null;
  consents: ConsentRecord[];
  notice: string;
}

export interface AuditEvent {
  id: number;
  at: string;
  actor: string;
  event: string;
  tool: string | null;
  scope: string | null;
  decision: 'allow' | 'deny' | 'info';
  detail: Record<string, unknown>;
}

export interface ToolInfo {
  name: string;
  server: string;
  kind: 'read' | 'write';
  scope: string;
  consent: string | null;
  description: string;
  fixture: string;
  approval_required: boolean;
}

export interface ProactiveAlert {
  alert_id: string;
  event_type: EventType;
  severity: 'high' | 'medium';
  title: string;
  detail: string;
  suggested_message: string;
}

export interface FinancialTwin {
  customer_id: string;
  as_of: string;
  summary: { status: 'attention' | 'watch' | 'healthy'; headline: string };
  net_position: { assets_inr: number; liabilities_inr: number; net_inr: number };
  assets: { label: string; value_inr: number; source: string }[];
  liabilities: { label: string; value_inr: number; source: string }[];
  cash_flow: { income_inr: number; essentials_inr: number; emi_inr: number; free_cash_inr: number; emi_to_income: number; source: string };
  emergency: { savings_inr: number; months_covered: number; buffer_inr: number };
  before_salary: { salary_date: string; due_inr: number; balance_inr: number; shortfall_inr: number };
  obligations: {
    title: string;
    kind: string;
    amount_inr: number;
    due_date: string;
    days_away: number;
    direction: 'in' | 'out';
    source: string;
  }[];
  insurance: { policy: string; kind: string; cover_inr: number; premium_inr: number; renewal_date: string; insurer: string; days_to_renewal: number }[];
  renewals_due: string[];
  goals: {
    goal: string;
    target_inr: number;
    saved_inr: number;
    target_date: string;
    progress_pct: number;
    monthly_needed_inr: number;
    months_left: number;
  }[];
  notice: string;
}

export interface PlaybookInfo {
  id: string;
  version: number;
  title: string;
  event_type: EventType;
  engine: string;
  triggers: string[];
  tools: { read: string[]; write: string[] };
  exit: string;
}

export interface KeyFactStatement {
  kfs_id: string;
  lender: string;
  product: string;
  principal_inr: number;
  interest_rate_pct: number;
  approx_apr_pct: number;
  tenure_months: number;
  monthly_emi_inr: number;
  total_interest_inr: number;
  processing_fee_inr: number;
  total_payable_inr: number;
  cooling_off_days: number;
  disbursed_to: string;
  grievance_contact: string;
  notice: string;
}
