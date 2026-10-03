import type {
  CreditScore,
  ScoreSimulation,
  AffordabilityAssessment,
  AssetsResponse,
  CashForecast,
  FinancialTwin,
  ProactiveAlert,
  AuditEvent,
  CaseRecord,
  CaseSummary,
  DocumentItem,
  EvidenceResponse,
  FinancialContext,
  Goal,
  GoalInput,
  GoalStatus,
  Insights,
  IntegrationStatus,
  Passport,
  Session,
  SessionUser,
  StandingConsents,
} from './types';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const SESSION_KEY = 'saathi.session';
let token: string | null = null;
let onUnauthorized: (() => void) | null = null;

export function loadSession(): Session | null {
  try {
    const session = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as Session | null;
    if (!session || session.expires_at < Date.now()) return null;
    token = session.token;
    return session;
  } catch {
    return null;
  }
}

export function saveSession(session: Session | null): void {
  token = session?.token ?? null;
  if (session) sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  else sessionStorage.removeItem(SESSION_KEY);
}

export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

export const GENERIC_ERROR = 'Something went wrong while processing your request. Please try again.';
const OFFLINE_ERROR = "Saathi can't be reached right now. Check your connection and try again.";

// Only short, customer-readable details are shown. Server faults and validation internals become a plain message.
function detailMessage(status: number, data: unknown): string {
  if (status >= 500) return GENERIC_ERROR;
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string' && detail.length <= 200) return detail;
  if (Array.isArray(detail)) {
    const messages = detail.map((item: { msg?: unknown }) => (typeof item.msg === 'string' ? item.msg : '')).filter(Boolean);
    if (messages.length) return `Please check your details: ${messages.slice(0, 2).join('; ')}`;
  }
  return GENERIC_ERROR;
}

export const errorMessage = (caught: unknown): string => (caught instanceof ApiError ? caught.message : GENERIC_ERROR);

async function request<T>(path: string, init: RequestInit & { json?: unknown } = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(init.json);
  }
  let response: Response;
  try {
    response = await fetch(path, { ...init, headers, body });
  } catch {
    throw new ApiError(0, OFFLINE_ERROR);
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (response.status === 401 && token) onUnauthorized?.();
  if (!response.ok) throw new ApiError(response.status, detailMessage(response.status, data));
  return data as T;
}

const post = <T>(path: string, json: unknown = {}) => request<T>(path, { method: 'POST', json });
const patch = <T>(path: string, json: unknown) => request<T>(path, { method: 'PATCH', json });
const remove = (path: string) => request<null>(path, { method: 'DELETE' });

export const api = {
  integrations: () => request<IntegrationStatus>('/api/integrations/status'),
  accounts: () => request<{ users: SessionUser[] }>('/api/auth/demo-users'),
  login: (user_id: string, passcode: string) =>
    post<{ access_token: string; expires_in: number; user: SessionUser }>('/api/auth/login', { user_id, passcode }),
  listCases: () => request<{ cases: CaseSummary[] }>('/api/cases'),
  supportCases: () => request<{ cases: CaseSummary[] }>('/api/support/cases'),
  getCase: (caseId: string) => request<CaseRecord>(`/api/cases/${caseId}`),
  // Every chat message, typed, spoken, or tapped, goes through this one pipeline unchanged.
  chat: (message: string, conversationId?: string | null, language?: string) =>
    post<CaseRecord>('/api/chat', {
      message,
      ...(conversationId ? { conversation_id: conversationId } : {}),
      ...(language ? { language } : {}),
    }),
  newConversation: (language?: string) => post<CaseRecord>('/api/conversations', language ? { language } : {}),
  renameConversation: (caseId: string, title: string) => patch<CaseSummary>(`/api/cases/${caseId}`, { title }),
  deleteConversation: (caseId: string) => remove(`/api/cases/${caseId}`),
  deleteAllConversations: () => request<{ deleted: number; kept: number }>('/api/conversations', { method: 'DELETE' }),
  goals: () => request<{ goals: Goal[] }>('/api/goals'),
  createGoal: (goal: GoalInput) => post<Goal>('/api/goals', goal),
  updateGoal: (goalId: string, changes: Partial<GoalInput> & { status?: GoalStatus }) => patch<Goal>(`/api/goals/${goalId}`, changes),
  deleteGoal: (goalId: string) => remove(`/api/goals/${goalId}`),
  insights: () => request<Insights>('/api/insights'),
  financialContext: () => request<FinancialContext>('/api/financial-context'),
  documents: () => request<{ documents: DocumentItem[] }>('/api/documents'),
  consents: () => request<StandingConsents>('/api/consents'),
  setConsents: (changes: Partial<StandingConsents>) => post<StandingConsents>('/api/consents', changes),
  speak: (text: string, language_code: string) =>
    post<{ audio_base64: string; mime_type: string }>('/api/voice/speak', { text, language_code, consent: true }),
  setConsent: (caseId: string, granted: boolean) =>
    post<CaseRecord>(`/api/cases/${caseId}/consents`, { purpose: 'prepare_resolution_options', granted }),
  confirmTransaction: (caseId: string, transaction_id: string, recognized: boolean) =>
    post<CaseRecord>(`/api/cases/${caseId}/transaction-confirmation`, { transaction_id, recognized }),
  handoff: (caseId: string, reason?: string) => post<CaseRecord>(`/api/cases/${caseId}/handoff`, reason ? { reason } : {}),
  passport: (caseId: string) => request<Passport>(`/api/cases/${caseId}/passport`),
  audit: (caseId: string) => request<{ events: AuditEvent[] }>(`/api/cases/${caseId}/audit`),
  evidence: (caseId: string) => request<EvidenceResponse>(`/api/cases/${caseId}/evidence`),
  uploadDocument: (caseId: string, documentType: 'bill' | 'policy', file: File, ocrConsent = false) => {
    const form = new FormData();
    form.append('document_type', documentType);
    if (ocrConsent) form.append('ocr_consent', 'true');
    form.append('file', file);
    return request<{ document_id: string; document_name: string; page_count: number }>(`/api/cases/${caseId}/documents`, { method: 'POST', body: form });
  },
  analyze: (caseId: string) => post<{ analysis: unknown }>(`/api/cases/${caseId}/analyze`, { confirm_external_processing: true }),
  transcribe: (audio: Blob, filename: string, language?: string) => {
    const form = new FormData();
    form.append('consent_to_transcribe', 'true');
    if (language) form.append('language_code', language);
    form.append('file', audio, filename);
    return request<{ transcript: string; language_code: string | null }>('/api/voice/transcribe', { method: 'POST', body: form });
  },
  prepareAction: (caseId: string, option_id: string) => post<CaseRecord>(`/api/cases/${caseId}/actions`, { option_id }),
  approveAction: (caseId: string, actionId: string, payload_hash: string) =>
    post<CaseRecord>(`/api/cases/${caseId}/actions/${actionId}/approve`, { payload_hash, confirm: true }),
  cancelAction: (caseId: string, actionId: string) => post<CaseRecord>(`/api/cases/${caseId}/actions/${actionId}/cancel`),
  confirmBill: (caseId: string, document_id: string, confirmed: boolean, total_inr?: number) =>
    post<CaseRecord>(`/api/cases/${caseId}/bill-confirmation`, { document_id, confirmed, ...(total_inr ? { total_inr } : {}) }),
  twin: () => request<FinancialTwin>('/api/twin'),
  forecast: (salaryDelayDays = 0, skip: string[] = []) =>
    request<CashForecast>(
      `/api/forecast?salary_delay_days=${salaryDelayDays}${skip.length ? `&skip=${encodeURIComponent(skip.join(','))}` : ''}`,
    ),
  creditScore: () => post<CreditScore>('/api/credit/score', { consent: true }),
  simulateScore: (action: ScoreSimulation['action']) => post<ScoreSimulation>('/api/credit/simulate', { consent: true, action }),
  afford: (question: string) => post<AffordabilityAssessment>('/api/afford', { question }),
  assets: () => request<AssetsResponse>('/api/assets'),
  linkAssets: (body: { pan?: string; use_kyc_pan?: boolean }) => post<AssetsResponse>('/api/assets/link', { ...body, consent: true }),
  unlinkAssets: () => request<AssetsResponse>('/api/assets/link', { method: 'DELETE' }),
  alerts: () => request<{ enabled: boolean; alerts: ProactiveAlert[] }>('/api/alerts'),
  setAlerts: (enabled: boolean) => post<{ enabled: boolean; alerts: ProactiveAlert[] }>('/api/alerts/settings', { enabled }),
  dismissAlert: (alertId: string) =>
    post<{ enabled: boolean; alerts: ProactiveAlert[] }>(`/api/alerts/${encodeURIComponent(alertId)}/dismiss`),
  claimCase: (caseId: string) => post<CaseRecord>(`/api/support/cases/${caseId}/claim`),
  specialistNote: (caseId: string, text: string, to_customer: boolean) =>
    post<CaseRecord>(`/api/support/cases/${caseId}/notes`, { text, to_customer }),
  reviewCase: (caseId: string, body: { verify_documents: boolean; option_id?: string; message?: string }) =>
    post<CaseRecord>(`/api/support/cases/${caseId}/review`, body),
  resolveCase: (caseId: string, note: string) => post<CaseRecord>(`/api/support/cases/${caseId}/resolve`, { note }),
};

// Live case feed over Server-Sent Events, read with fetch so the token stays in the Authorization header.
export async function streamCase(caseId: string, onRecord: (record: CaseRecord) => void, signal: AbortSignal): Promise<void> {
  const response = await fetch(`/api/cases/${caseId}/events`, {
    headers: token ? { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' } : {},
    signal,
  });
  if (!response.ok || !response.body) throw new ApiError(response.status, 'Live updates are unavailable.');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value;
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = frame
        .split('\n')
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice(6))
        .join('\n');
      if (data) onRecord(JSON.parse(data) as CaseRecord);
      boundary = buffer.indexOf('\n\n');
    }
  }
}
