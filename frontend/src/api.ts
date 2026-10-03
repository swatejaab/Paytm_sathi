import type {
  AgentNodeInfo,
  PlaybookInfo,
  FinancialTwin,
  ProactiveAlert,
  AuditEvent,
  CaseRecord,
  CaseSummary,
  EvidenceResponse,
  IntegrationStatus,
  Passport,
  Session,
  SessionUser,
  ToolInfo,
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

function detailMessage(data: unknown): string | null {
  const detail = (data as { detail?: unknown } | null)?.detail;
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail.map((item) => `${(item.loc ?? []).join('.')}: ${item.msg}`).join('; ');
  }
  return null;
}

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
    throw new ApiError(0, 'Saathi API is unreachable. Start the backend with "npm run dev".');
  }
  const text = await response.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (response.status === 401 && token) onUnauthorized?.();
  if (!response.ok) throw new ApiError(response.status, detailMessage(data) ?? `Request failed (${response.status}).`);
  return data as T;
}

const post = <T>(path: string, json: unknown = {}) => request<T>(path, { method: 'POST', json });

export const api = {
  health: () => request<{ status: string; service: string }>('/api/health'),
  integrations: () => request<IntegrationStatus>('/api/integrations/status'),
  demoUsers: () => request<{ users: SessionUser[] }>('/api/auth/demo-users'),
  login: (user_id: string, passcode: string) =>
    post<{ access_token: string; expires_in: number; user: SessionUser }>('/api/auth/login', { user_id, passcode }),
  listCases: () => request<{ cases: CaseSummary[] }>('/api/cases'),
  supportCases: () => request<{ cases: CaseSummary[] }>('/api/support/cases'),
  getCase: (caseId: string) => request<CaseRecord>(`/api/cases/${caseId}`),
  createCase: (message: string, consent: boolean, language?: string) =>
    post<CaseRecord>('/api/cases/intake', { message, consent_to_read_case_data: consent, ...(language ? { language } : {}) }),
  chat: (caseId: string, message: string, language?: string) =>
    post<CaseRecord>(`/api/cases/${caseId}/chat`, { message, confirm_external_processing: true, ...(language ? { language } : {}) }),
  speak: (text: string, language_code: string) =>
    post<{ audio_base64: string; mime_type: string }>('/api/voice/speak', { text, language_code, consent: true }),
  setConsent: (caseId: string, granted: boolean) =>
    post<CaseRecord>(`/api/cases/${caseId}/consents`, { purpose: 'prepare_resolution_options', granted }),
  confirmTransaction: (caseId: string, transaction_id: string, recognized: boolean) =>
    post<CaseRecord>(`/api/cases/${caseId}/transaction-confirmation`, { transaction_id, recognized }),
  handoff: (caseId: string) => post<CaseRecord>(`/api/cases/${caseId}/handoff`, {}),
  passport: (caseId: string) => request<Passport>(`/api/cases/${caseId}/passport`),
  audit: (caseId: string) => request<{ events: AuditEvent[] }>(`/api/cases/${caseId}/audit`),
  tools: () => request<{ tools: ToolInfo[] }>('/api/mcp/tools'),
  playbooks: () => request<{ playbooks: PlaybookInfo[] }>('/api/playbooks'),
  agentGraph: () => request<{ graph: string; engine: string; nodes: AgentNodeInfo[] }>('/api/agent/graph'),
  evidence: (caseId: string) => request<EvidenceResponse>(`/api/cases/${caseId}/evidence`),
  uploadDocument: (caseId: string, documentType: 'bill' | 'policy', file: File, ocrConsent = false) => {
    const form = new FormData();
    form.append('document_type', documentType);
    if (ocrConsent) form.append('ocr_consent', 'true');
    form.append('file', file);
    return request<{ document_name: string; page_count: number }>(`/api/cases/${caseId}/documents`, { method: 'POST', body: form });
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
