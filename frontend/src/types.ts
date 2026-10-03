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
export type EventType = 'hospitalization' | 'upi_dispute' | 'emi_shortfall' | 'failed_refund' | 'protection' | 'general_financial_support';
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
  coverage_breakdown?: CoverageAssessment | null;
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

export interface GoalImpact {
  summary: string;
  free_cash_monthly_inr: number;
  goals_monthly_need_inr: number;
  earmarked_inr: number;
  focus_goal: string;
  delay_months: number | null;
}

export type ChatCard =
  | { type: 'gap'; lines: GapLine[]; formula: string }
  | { type: 'plan' }
  | { type: 'transactions' }
  | { type: 'bill_confirmation' }
  | { type: 'afford'; assessment: AffordabilityAssessment & { goal_impact?: GoalImpact | null } }
  | { type: 'goal_draft'; goal: GoalDraft; required_monthly_inr: number | null; months_left: number | null };

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  at: string;
  original?: string;
  language?: string;
  understood?: string;
  source?: 'saathi' | 'openai';
  quick_replies?: QuickReply[];
  card?: ChatCard;
}

export type JourneyId = 'hospital' | 'bill' | 'upi_fraud' | 'failed_refund' | 'emi' | 'protection' | 'afford' | 'goal' | 'specialist' | 'general';

export interface Slot<T> {
  value: T;
  source: string;
  ref: string;
  confidence: number;
  updated_at: string;
}

export interface ConversationContext {
  journey: JourneyId | null;
  slots: Partial<Record<string, Slot<number | string | boolean>>>;
  awaiting: string | null;
  missing: string[];
  gap: GapCalculation | null;
  records?: FetchedRecords | null;
  updated_at: string;
}

export interface FetchedRecords {
  policy: { policy_name: string; insurer: string; sum_insured_inr: number; cashless_network: string[] } | null;
  admission: { hospital: string; patient: string; relation: string; ward: string; cashless: boolean; total_inr: number; missing_documents: string[] } | null;
  cash: { balance_inr: number; next_salary_date: string | null; safe_to_pay_inr: number } | null;
}

export interface CaseRecord {
  case_id: string;
  customer_id: string;
  title?: string;
  title_locked?: boolean;
  context?: ConversationContext;
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
  title: string;
  journey: JourneyId | null;
  event_type: EventType;
  urgency: string;
  status: CaseStatus;
  customer_message: string;
  last_message: string | null;
  message_count: number;
  has_plan: boolean;
  recommended_option: string | null;
  created_at: string;
  updated_at: string;
}

export const GOAL_TYPES = [
  'emergency_fund',
  'home',
  'vehicle',
  'education',
  'wedding',
  'travel',
  'retirement',
  'debt_repayment',
  'custom',
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];
export type GoalStatus = 'active' | 'paused' | 'completed';
export type GoalPriority = 'high' | 'medium' | 'low';

export interface GoalInput {
  name: string;
  type: GoalType;
  target_inr: number;
  target_date: string | null;
  current_savings_inr: number;
  monthly_contribution_inr: number | null;
  priority: GoalPriority;
}

export interface Goal extends GoalInput {
  goal_id: string;
  status: GoalStatus;
  created_at: string;
  updated_at: string;
  remaining_inr: number;
  progress_pct: number;
  months_left: number | null;
  required_monthly_inr: number | null;
  expected_completion: string | null;
  on_track: boolean | null;
}

export interface ProactiveInsight {
  id: string;
  tone: 'good' | 'info' | 'warn' | 'alert';
  title: string;
  detail: string;
  ask?: string;
}

export interface Insights {
  as_of: string;
  period: { month: string; label: string };
  kpis: {
    income_inr: number;
    spending_inr: number;
    savings_inr: number;
    savings_rate_pct: number;
    upcoming_obligations_inr: number;
    upcoming_count: number;
    outstanding_debt_inr: number;
    monthly_emi_inr: number;
    health: { score: number; band: string; parts: { label: string; score: number; max: number }[] };
  };
  months: { month: string; label: string; income_inr: number; spending_inr: number; emi_inr: number; invested_inr: number; net_inr: number }[];
  cash_flow: { month: string; label: string; net_inr: number; cumulative_inr: number }[];
  categories: { category: string; amount_inr: number }[];
  debts: { name: string; outstanding_inr: number; emi_inr: number; kind: string }[];
  goals: { goal_id: string; name: string; target_inr: number; saved_inr: number; progress_pct: number; status: GoalStatus }[];
  upcoming: { title: string; kind: string; amount_inr: number; due_date: string; days_away: number }[];
  insights: ProactiveInsight[];
  sources: string[];
}

export interface FinancialContext {
  monthlyIncome: number | null;
  averageExpenses: number | null;
  availableCash: number | null;
  emergencyFund: number | null;
  existingLoans: { name: string; outstanding_inr: number; emi_inr: number | null; next_due_date: string | null }[] | null;
  monthlyEMIs: number | null;
  insurancePolicies: { policy: string; kind: string; cover_inr: number; renewal_date: string; days_to_renewal: number }[] | null;
  investments: { name: string; value_inr: number }[] | null;
  upcomingBills: { title: string; amount_inr: number; due_date: string; days_away: number }[] | null;
  financialGoals: Goal[];
  sources: Record<string, string>;
}

export interface StandingConsents {
  records: boolean;
  ai: boolean;
  voice: boolean;
}

export interface DocumentItem {
  document_id: string;
  document_name: string;
  document_type: 'bill' | 'policy';
  page_count: number;
  uploaded_at: string;
  case_id: string;
  conversation_title: string | null;
  confirmed: boolean;
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
  goals: Goal[];
  notice: string;
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

export interface CoverageAssessment {
  rules_version: string;
  lines: {
    line: number;
    description: string;
    category: 'room' | 'pharmacy' | 'medical';
    billed_inr: number;
    payable_inr: number;
    not_payable_inr: number;
    status: 'payable' | 'capped' | 'partly_excluded' | 'excluded';
    clause_id: string;
    reason: string;
  }[];
  payable_before_deductible_inr: number;
  deductible_inr: number;
  deductible_clause_id: string;
  sum_insured_inr: number;
  estimated_coverage_inr: number;
  not_covered_inr: number;
  assumptions: string[];
}

export interface CashForecast {
  as_of: string;
  horizon_days: number;
  what_if: { salary_delay_days: number; skip: string[] };
  opening_balance_inr: number;
  payday: string;
  salary_inr: number;
  days: { date: string; balance_inr: number; events: { id: string; title: string; amount_inr: number; direction: 'in' | 'out' }[] }[];
  lowest: { date: string; balance_inr: number };
  first_negative_date: string | null;
  crunch_inr: number;
  safe_to_spend_inr: number;
  end_balance_inr: number;
  items: { id: string; title: string; kind: string; amount_inr: number; due_date: string; direction: 'in' | 'out'; flexible: boolean }[];
  fixes: { id: string; title: string; detail: string; cost_inr: number; relief_inr: number; playbook_message: string | null }[];
  best_plan: { fix_ids: string[]; cost_inr: number; summary: string } | null;
  plan_without_new_loan: { fix_ids: string[]; cost_inr: number; summary: string } | null;
  headline: string;
  method: string;
}

export interface AffordabilityAssessment {
  item: string;
  amount_inr: number;
  category: 'vehicle' | 'purchase';
  verdict: 'yes' | 'yes_with_plan' | 'not_now';
  headline: string;
  recommended_id: string | null;
  scenarios: {
    id: string;
    title: string;
    upfront_inr: number;
    monthly_emi_inr: number;
    months: number;
    extra_cost_inr: number;
    emi_to_income: number | null;
    savings_after_inr: number | null;
    status: 'comfortable' | 'manageable' | 'high_stress' | 'not_possible' | 'wait';
    effect: string;
  }[];
  context: {
    free_balance_inr: number;
    spare_savings_inr: number;
    emergency_buffer_inr: number;
    free_cash_monthly_inr: number;
    existing_emi_inr: number;
    monthly_income_inr: number;
  };
  warning: string | null;
  method: string;
}

export interface CreditScore {
  bureau: string;
  soft_pull: boolean;
  report: { report_id: string; as_of: string };
  score: number;
  band: string;
  tone: 'excellent' | 'good' | 'fair' | 'poor';
  factors: { id: string; label: string; value: string; points: number; max_points: number; status: 'good' | 'fair' | 'poor'; detail: string; tip: string }[];
  model: string;
}

export interface ScoreSimulation {
  action: 'pay_card_to_10' | 'take_small_loan' | 'miss_one_emi' | 'close_oldest_card';
  label: string;
  before: number;
  after: number;
  delta: number;
  band_after: string;
  changed: { id: string; label: string; delta: number }[];
}

interface SuggestedProductBase {
  option_id: string;
  option_title: string;
  why: string;
  partner: string;
  product: string;
  other_steps: string[];
  simulated: true;
  commission_considered: false;
}

export type SuggestedProduct =
  | (SuggestedProductBase & {
      kind: 'loan';
      amount_inr: number;
      interest_rate_pct: number;
      tenure_months: number;
      monthly_emi_inr: number;
      total_interest_inr: number;
      processing_fee_inr: number;
      total_payable_inr: number;
      disbursal_days: number;
      disburse_to: 'hospital' | 'customer';
    })
  | (SuggestedProductBase & {
      kind: 'insurance';
      sum_assured_inr: number;
      term_years: number;
      annual_premium_inr: number;
      monthly_equivalent_inr: number;
      cover_until_age: number | null;
    });

export type AssetClassId = 'savings' | 'fixed_deposits' | 'mutual_funds' | 'stocks' | 'retirement' | 'gold';

export interface Portfolio {
  pan_masked: string;
  pan_name: string;
  as_of: string;
  total_assets_inr: number;
  total_liabilities_inr: number;
  net_worth_inr: number;
  liquid_inr: number;
  market_value_inr: number;
  market_gain_inr: number;
  market_gain_pct: number;
  monthly_sip_inr: number;
  classes: { id: AssetClassId; label: string; value_inr: number; invested_inr: number; count: number }[];
  holdings: {
    bank_accounts: { institution: string; account_type: string; masked: string; balance_inr: number }[];
    fixed_deposits: { institution: string; name: string; principal_inr: number; value_inr: number; rate_pct: number; maturity_date: string }[];
    mutual_funds: {
      scheme: string;
      amc: string;
      category: string;
      registrar: string;
      units: number;
      nav_inr: number;
      invested_inr: number;
      value_inr: number;
      sip_inr: number;
    }[];
    stocks: {
      symbol: string;
      name: string;
      exchange: string;
      depository: string;
      quantity: number;
      avg_price_inr: number;
      ltp_inr: number;
      invested_inr: number;
      value_inr: number;
    }[];
    retirement: { name: string; institution: string; invested_inr: number; value_inr: number }[];
    gold: { name: string; units: number; invested_inr: number; value_inr: number }[];
  };
  liabilities: { label: string; value_inr: number; source: string }[];
  history: { month: string; net_worth_inr: number }[];
  sources: { id: string; name: string }[];
  simulated: boolean;
  notice: string;
}

export type AssetsResponse =
  | { linked: false; pan_on_file: string | null }
  | { linked: true; linked_at: string; pan_on_file: string; portfolio: Portfolio };
