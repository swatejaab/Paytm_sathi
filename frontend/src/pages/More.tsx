import { useState, type ReactNode } from 'react';
import { api, errorMessage } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { ConfirmDialog, EmptyState, ErrorState, Skeleton, Toggle, useAsync } from '../components/ui';
import { dateTime, EVENT_LABELS, inr, LANGUAGES, readPref, relativeTime, shortDate, STATUS_LABELS, writePref } from '../format';
import { navigate, routeHref } from '../router';
import type { Theme } from '../theme';
import { useToast } from '../toast';
import type { IntegrationStatus, SessionUser, StandingConsents } from '../types';

type SectionId =
  | 'profile'
  | 'financial'
  | 'accounts'
  | 'history'
  | 'documents'
  | 'cases'
  | 'notifications'
  | 'consents'
  | 'privacy'
  | 'services'
  | 'permissions'
  | 'language'
  | 'theme'
  | 'notification-prefs'
  | 'help'
  | 'faqs'
  | 'about';

const GROUPS: { title: string; items: { id: SectionId; label: string; icon: IconName }[] }[] = [
  {
    title: 'Profile',
    items: [
      { id: 'profile', label: 'Personal Info', icon: 'user' },
      { id: 'financial', label: 'Financial Profile', icon: 'rupee' },
      { id: 'accounts', label: 'Linked Accounts', icon: 'link' },
    ],
  },
  {
    title: 'Saathi',
    items: [
      { id: 'history', label: 'Chat History', icon: 'chat' },
      { id: 'documents', label: 'Uploaded Documents', icon: 'file' },
      { id: 'cases', label: 'Financial Cases', icon: 'folder' },
      { id: 'notifications', label: 'Notifications', icon: 'bell' },
    ],
  },
  {
    title: 'Security & Privacy',
    items: [
      { id: 'consents', label: 'Consent Management', icon: 'shield' },
      { id: 'privacy', label: 'Privacy Settings', icon: 'lock' },
      { id: 'services', label: 'Connected Services', icon: 'grid' },
      { id: 'permissions', label: 'Data Permissions', icon: 'eye' },
    ],
  },
  {
    title: 'Preferences',
    items: [
      { id: 'language', label: 'Language', icon: 'globe' },
      { id: 'theme', label: 'Theme', icon: 'sun' },
      { id: 'notification-prefs', label: 'Notification Preferences', icon: 'settings' },
    ],
  },
  {
    title: 'Help',
    items: [
      { id: 'help', label: 'Help & Support', icon: 'headset' },
      { id: 'faqs', label: 'FAQs', icon: 'help' },
      { id: 'about', label: 'About', icon: 'info' },
    ],
  },
];
const ALL_ITEMS = GROUPS.flatMap((group) => group.items);

interface Props {
  section: string | null;
  user: SessionUser;
  integrations: IntegrationStatus;
  theme: Theme;
  onTheme: (theme: Theme) => void;
  onAsk: (text: string) => void;
  onLogout: () => void;
}

function Rows({ rows }: { rows: { label: string; value: ReactNode; note?: string }[] }) {
  return (
    <dl className="info-rows">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>
            {row.label}
            {row.note && <small className="muted">{row.note}</small>}
          </dt>
          <dd>{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

const unknown = <span className="muted">Not available</span>;
const money = (value: number | null) => (value === null ? unknown : inr(value));

function PersonalInfo({ user }: { user: SessionUser }) {
  return (
    <>
      <Rows
        rows={[
          { label: 'Name', value: user.display_name },
          { label: 'Account type', value: user.role === 'support' ? 'Saathi specialist' : 'Paytm customer' },
          { label: 'Sign-in', value: 'Passcode' },
        ]}
      />
      <p className="muted small">Contact details are managed in your Paytm profile. Saathi doesn't need them to help you.</p>
    </>
  );
}

function FinancialProfile() {
  const { data, error, loading, reload } = useAsync(() => api.financialContext());
  if (loading && !data) return <Skeleton lines={6} />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      <Rows
        rows={[
          { label: 'Monthly income', value: money(data.monthlyIncome), note: data.sources.monthlyIncome },
          { label: 'Average monthly expenses', value: money(data.averageExpenses), note: data.sources.averageExpenses },
          { label: 'Available cash', value: money(data.availableCash), note: data.sources.availableCash },
          { label: 'Emergency fund', value: money(data.emergencyFund), note: data.sources.emergencyFund },
          { label: 'Monthly EMIs', value: money(data.monthlyEMIs), note: data.sources.monthlyEMIs },
        ]}
      />
      <h3>Loans</h3>
      {data.existingLoans?.length ? (
        <Rows
          rows={data.existingLoans.map((loan) => ({
            label: loan.name,
            value: inr(loan.outstanding_inr),
            note: [loan.emi_inr ? `EMI ${inr(loan.emi_inr)}` : '', loan.next_due_date ? `next due ${shortDate(loan.next_due_date)}` : ''].filter(Boolean).join(' · '),
          }))}
        />
      ) : (
        <p className="muted small">{data.existingLoans ? 'No active loans.' : 'Not available.'}</p>
      )}
      <h3>Insurance</h3>
      {data.insurancePolicies?.length ? (
        <Rows
          rows={data.insurancePolicies.map((policy) => ({
            label: policy.policy,
            value: `${inr(policy.cover_inr)} cover`,
            note: `${policy.kind} · renews ${shortDate(policy.renewal_date)}`,
          }))}
        />
      ) : (
        <p className="muted small">{data.insurancePolicies ? 'No policies on record.' : 'Not available.'}</p>
      )}
      <h3>Investments</h3>
      {data.investments?.length ? (
        <Rows rows={data.investments.map((item) => ({ label: item.name, value: inr(item.value_inr) }))} />
      ) : (
        <p className="muted small">{data.investments ? 'No investments on record.' : 'Not available.'}</p>
      )}
      <p className="muted small">Saathi uses these figures only when they're relevant to your question. Anything not available is left blank rather than guessed.</p>
    </>
  );
}

function LinkedAccounts() {
  const { data, error, loading, reload } = useAsync(() => api.twin());
  if (loading && !data) return <Skeleton lines={5} />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      <h3>Balances and savings</h3>
      <Rows rows={data.assets.map((asset) => ({ label: asset.label, value: inr(asset.value_inr), note: asset.source }))} />
      <h3>Loans and cards</h3>
      {data.liabilities.length ? (
        <Rows rows={data.liabilities.map((item) => ({ label: item.label, value: inr(item.value_inr), note: item.source }))} />
      ) : (
        <p className="muted small">None.</p>
      )}
      <p className="muted small">{data.notice}</p>
    </>
  );
}

function ChatHistory() {
  const toast = useToast();
  const { data, error, loading, reload } = useAsync(() => api.listCases());
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const clear = async () => {
    setBusy(true);
    try {
      const result = await api.deleteAllConversations();
      toast(
        result.kept ? `Deleted ${result.deleted} chats. ${result.kept} with requests in progress were kept.` : `Deleted ${result.deleted} chat${result.deleted === 1 ? '' : 's'}`,
        'success',
      );
      setConfirming(false);
      void reload();
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (loading && !data) return <Skeleton lines={5} />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      {data.cases.length === 0 ? (
        <EmptyState icon="chat" title="No chats yet" action={<a className="btn btn-primary" href={routeHref('saathi', 'new')}>Start a chat</a>} />
      ) : (
        <ul className="link-list">
          {data.cases.map((chat) => (
            <li key={chat.case_id}>
              <a href={routeHref('saathi', chat.case_id)}>
                <span>
                  <strong>{chat.title}</strong>
                  <small className="muted">
                    {chat.message_count} messages · {relativeTime(chat.updated_at)}
                  </small>
                </span>
                <Icon name="next" size={18} />
              </a>
            </li>
          ))}
        </ul>
      )}
      {data.cases.length > 0 && (
        <button className="btn btn-ghost danger" onClick={() => setConfirming(true)}>
          <Icon name="trash" size={16} /> Delete all chats
        </button>
      )}
      {confirming && (
        <ConfirmDialog
          title="Delete all conversations?"
          body="All your chats and their messages will be removed. Chats with a partner request in progress are kept."
          confirmLabel="Delete all"
          danger
          busy={busy}
          onConfirm={() => void clear()}
          onCancel={() => setConfirming(false)}
        />
      )}
    </>
  );
}

function Documents() {
  const { data, error, loading, reload } = useAsync(() => api.documents());
  if (loading && !data) return <Skeleton lines={4} />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data.documents.length)
    return <EmptyState icon="file" title="No documents yet" body="Bills and policies you attach in a chat appear here. Saathi keeps only the extracted text." />;
  return (
    <ul className="link-list">
      {data.documents.map((document) => (
        <li key={document.document_id}>
          <a href={routeHref('saathi', document.case_id)}>
            <Icon name="file" size={20} />
            <span>
              <strong>{document.document_name}</strong>
              <small className="muted">
                {document.document_type === 'bill' ? 'Bill' : 'Insurance policy'} · {document.page_count} page{document.page_count === 1 ? '' : 's'} ·{' '}
                {dateTime(document.uploaded_at)}
                {document.conversation_title ? ` · ${document.conversation_title}` : ''}
              </small>
            </span>
            {document.confirmed && <span className="badge badge-green">Total confirmed</span>}
          </a>
        </li>
      ))}
    </ul>
  );
}

function Cases() {
  const { data, error, loading, reload } = useAsync(() => api.listCases());
  if (loading && !data) return <Skeleton lines={4} />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  const cases = data.cases.filter((item) => item.event_type !== 'general_financial_support' || item.has_plan);
  if (!cases.length) return <EmptyState icon="folder" title="No financial cases" body="When Saathi helps you with a bill, payment, or EMI, the case and its plan appear here." />;
  return (
    <ul className="link-list">
      {cases.map((item) => (
        <li key={item.case_id}>
          <a href={routeHref('saathi', item.case_id)}>
            <span>
              <strong>{item.title}</strong>
              <small className="muted">
                {EVENT_LABELS[item.event_type]} · {item.recommended_option ? `Recommended: ${item.recommended_option}` : 'No plan yet'}
              </small>
            </span>
            <span className={`badge badge-status status-${item.status}`}>{STATUS_LABELS[item.status]}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

function Notifications({ onAsk }: { onAsk: (text: string) => void }) {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(() => api.alerts());
  const dismiss = async (id: string) => {
    try {
      setData(await api.dismissAlert(id));
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    }
  };
  if (loading && !data) return <Skeleton lines={4} />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  if (!data.enabled)
    return (
      <EmptyState
        icon="bell"
        title="Alerts are off"
        body="Turn on proactive alerts in Notification Preferences to hear about upcoming EMIs and cash crunches."
        action={
          <a className="btn" href={routeHref('more', 'notification-prefs')}>
            Notification Preferences
          </a>
        }
      />
    );
  if (!data.alerts.length) return <EmptyState icon="bell" title="You're all caught up" body="Saathi will let you know when something needs your attention." />;
  return (
    <ul className="alert-list">
      {data.alerts.map((alert) => (
        <li key={alert.alert_id} className={`insight insight-${alert.severity === 'high' ? 'alert' : 'warn'}`}>
          <span className="insight-icon">
            <Icon name="bell" size={18} />
          </span>
          <div>
            <strong>{alert.title}</strong>
            <p>{alert.detail}</p>
            <div className="row gap-sm">
              <button className="btn btn-sm btn-primary" onClick={() => onAsk(alert.suggested_message)}>
                Ask Saathi
              </button>
              <button className="btn btn-sm btn-ghost" onClick={() => void dismiss(alert.alert_id)}>
                Dismiss
              </button>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}

const CONSENT_ITEMS: { key: keyof StandingConsents; title: string; body: string }[] = [
  {
    key: 'records',
    title: 'Read my financial records',
    body: 'Lets Saathi read balances, transactions, loans, and policies when you ask for help, without asking each time. Saathi still asks before any action.',
  },
  {
    key: 'ai',
    title: 'AI assistance for general questions',
    body: 'Lets Saathi use an AI service to answer general money questions. Calculations always use fixed rules, never AI.',
  },
  {
    key: 'voice',
    title: 'Voice processing',
    body: 'Lets Saathi send your voice recordings to Sarvam AI to convert speech to text. Recordings are not stored.',
  },
];

function Consents() {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(() => api.consents());
  const [saving, setSaving] = useState<keyof StandingConsents | null>(null);
  const change = async (key: keyof StandingConsents, value: boolean) => {
    setSaving(key);
    try {
      setData(await api.setConsents({ [key]: value }));
      toast(value ? 'Permission granted' : 'Permission withdrawn', 'success');
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setSaving(null);
    }
  };
  if (loading && !data) return <Skeleton lines={4} />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <>
      <ul className="setting-list">
        {CONSENT_ITEMS.map((item) => (
          <li key={item.key}>
            <div>
              <strong>{item.title}</strong>
              <p className="muted small">{item.body}</p>
            </div>
            <Toggle checked={data[item.key]} onChange={(value) => void change(item.key, value)} label={item.title} disabled={saving === item.key} />
          </li>
        ))}
      </ul>
      <p className="muted small">You can also give or withdraw permission inside each conversation. Withdrawing stops future access; it doesn't undo approved actions.</p>
    </>
  );
}

function Privacy() {
  return (
    <ul className="bullets">
      <li>Saathi reads your records only with your permission, and only for the conversation you're in.</li>
      <li>When you upload a bill or policy, Saathi keeps the extracted text with phone numbers and emails removed. The original file isn't stored.</li>
      <li>Every amount in a plan shows where it came from: what you told Saathi, a document, or your account records.</li>
      <li>Nothing happens to your money until you review and approve the exact steps and amounts.</li>
      <li>Options are never ranked by partner commission.</li>
      <li>
        You can delete any conversation from the chat history, or{' '}
        <a className="link" href={routeHref('more', 'history')}>
          delete all chats
        </a>
        .
      </li>
    </ul>
  );
}

function ConnectedServices({ integrations }: { integrations: IntegrationStatus }) {
  const browserVoice = typeof window !== 'undefined' && ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
  const rows = [
    {
      label: 'AI assistance (OpenAI)',
      value: integrations.openai_available ? 'Connected' : 'Not connected',
      note: 'Answers questions in your language once you allow AI answers, and reads photos of documents',
    },
    {
      label: 'Indian languages (Sarvam AI)',
      value: integrations.sarvam_available ? 'Connected' : integrations.openai_available ? 'Using OpenAI instead' : 'Not connected',
      note: 'Chat in Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi and Odia',
    },
    {
      label: 'Voice input',
      value: integrations.sarvam_available ? 'Sarvam AI' : browserVoice ? 'Browser speech recognition' : 'Not available',
      note: integrations.sarvam_available ? 'All 11 languages, with automatic language detection' : 'Uses the chat language you pick',
    },
    { label: 'Investments (PAN)', value: 'Simulated statements', note: 'Demat, mutual fund, bank and FD balances linked to your PAN' },
    { label: 'Partner network', value: 'Simulated responses', note: 'Insurers, lenders, and banks respond in simulation; no real money moves' },
    { label: 'Policy library', value: 'Available', note: 'Used to cite policy sections in your plan' },
  ];
  return <Rows rows={rows} />;
}

function DataPermissions() {
  const { data } = useAsync(() => api.consents());
  return (
    <>
      <h3>What Saathi can read{data ? (data.records ? ' (allowed)' : ' (asks first)') : ''}</h3>
      <ul className="bullets">
        <li>Account balances and recent transactions</li>
        <li>Loans, EMIs, and due dates</li>
        <li>Insurance policies and cover</li>
        <li>Monthly statements used for Insights</li>
        <li>Documents you upload in a chat</li>
      </ul>
      <h3>What Saathi can do</h3>
      <ul className="bullets">
        <li>Prepare a dispute, claim, or loan request for you to review</li>
        <li>Submit it only after you approve the exact steps and amounts</li>
        <li>Share your Resolution Passport only with the partners you approve</li>
      </ul>
      <a className="btn" href={routeHref('more', 'consents')}>
        Manage permissions
      </a>
    </>
  );
}

function Language() {
  const toast = useToast();
  const [language, setLanguage] = useState(() => readPref('saathi.language', ''));
  return (
    <>
      <label className="field">
        <span>Saathi replies in</span>
        <select
          className="input"
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value);
            writePref('saathi.language', event.target.value);
            toast('Language updated', 'success');
          }}
        >
          {LANGUAGES.map((item) => (
            <option key={item.code} value={item.code}>
              {item.label}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">With Auto, Saathi replies in the language you write in: type in Hindi, Tamil, Bengali or any other supported Indian language and it answers in the same language.</p>
    </>
  );
}

function ThemeSection({ theme, onTheme }: { theme: Theme; onTheme: (theme: Theme) => void }) {
  return (
    <div className="theme-choices" role="radiogroup" aria-label="Theme">
      {(['light', 'dark'] as const).map((option) => (
        <button key={option} role="radio" aria-checked={theme === option} className={`theme-choice ${theme === option ? 'selected' : ''}`} onClick={() => onTheme(option)}>
          <span className={`theme-preview preview-${option}`} aria-hidden>
            <i />
            <i />
          </span>
          <Icon name={option === 'light' ? 'sun' : 'moon'} size={18} />
          {option === 'light' ? 'Light' : 'Dark'}
        </button>
      ))}
    </div>
  );
}

function NotificationPrefs() {
  const toast = useToast();
  const { data, error, loading, reload, setData } = useAsync(() => api.alerts());
  const [saving, setSaving] = useState(false);
  if (loading && !data) return <Skeleton lines={2} />;
  if (error || !data) return <ErrorState message={error} onRetry={reload} />;
  return (
    <ul className="setting-list">
      <li>
        <div>
          <strong>Proactive alerts</strong>
          <p className="muted small">Saathi checks your records for upcoming EMIs, possible cash shortfalls, and renewals, and lets you know early.</p>
        </div>
        <Toggle
          checked={data.enabled}
          label="Proactive alerts"
          disabled={saving}
          onChange={async (value) => {
            setSaving(true);
            try {
              setData(await api.setAlerts(value));
              toast(value ? 'Alerts turned on' : 'Alerts turned off', 'success');
            } catch (caught) {
              toast(errorMessage(caught), 'error');
            } finally {
              setSaving(false);
            }
          }}
        />
      </li>
    </ul>
  );
}

function Help({ onAsk }: { onAsk: (text: string) => void }) {
  return (
    <>
      <div className="help-grid">
        <button className="help-card" onClick={() => onAsk('I want to talk to a specialist')}>
          <Icon name="headset" size={22} />
          <strong>Talk to a specialist</strong>
          <small className="muted">A Saathi specialist continues in your chat</small>
        </button>
        <a className="help-card" href="tel:1930">
          <Icon name="alert" size={22} />
          <strong>Cyber fraud helpline: 1930</strong>
          <small className="muted">Call right away if money was taken without your permission</small>
        </a>
        <a className="help-card" href="https://cybercrime.gov.in" target="_blank" rel="noopener noreferrer">
          <Icon name="globe" size={22} />
          <strong>cybercrime.gov.in</strong>
          <small className="muted">File an online complaint about fraud</small>
        </a>
        <button className="help-card" onClick={() => navigate('more', 'faqs')}>
          <Icon name="help" size={22} />
          <strong>FAQs</strong>
          <small className="muted">Answers to common questions</small>
        </button>
      </div>
    </>
  );
}

const FAQS = [
  {
    q: 'Does Saathi move my money on its own?',
    a: 'No. Saathi can understand your situation, recommend options, and prepare requests, but nothing is submitted until you review and approve the exact steps and amounts.',
  },
  {
    q: 'Where do the numbers in my plan come from?',
    a: 'From what you tell Saathi, the documents you upload, or your account records. Each number shows its source, and Saathi asks when something is missing instead of guessing.',
  },
  {
    q: 'Is the AI doing the maths?',
    a: 'No. Fixed, tested rules do every calculation, such as the funding gap. AI helps understand your message and explain the options.',
  },
  {
    q: 'How are options ranked?',
    a: 'On cost, risk, time, and effort. Partner commission is never considered.',
  },
  {
    q: 'Can I speak instead of typing?',
    a: 'Yes. Tap the mic, speak in English, Hindi, or Hinglish, then check and edit the text before you send it.',
  },
  {
    q: 'How do I delete a conversation?',
    a: 'Open the chat history, tap ⋮ next to the conversation, and choose Delete.',
  },
];

function Faqs() {
  return (
    <div className="faq">
      {FAQS.map((item) => (
        <details key={item.q}>
          <summary>{item.q}</summary>
          <p>{item.a}</p>
        </details>
      ))}
    </div>
  );
}

function About() {
  return (
    <>
      <p>
        <strong>Paytm Saathi</strong> is your AI companion for everyday financial decisions and emergencies, from hospital bills and unknown UPI
        payments to EMIs, purchases, and savings goals.
      </p>
      <ul className="bullets">
        <li>AI understands, recommends, and prepares. You decide and approve.</li>
        <li>Every calculation is deterministic and explained.</li>
        <li>Insurers decide claims, banks decide disputes, and regulated lenders decide credit.</li>
        <li>Partner responses for claims, credit, and payments are simulated in this version; no real money moves.</li>
      </ul>
    </>
  );
}

export function More({ section, user, integrations, theme, onTheme, onAsk, onLogout }: Props) {
  const current = ALL_ITEMS.find((item) => item.id === section) ?? null;

  const content = (id: SectionId): ReactNode => {
    switch (id) {
      case 'profile':
        return <PersonalInfo user={user} />;
      case 'financial':
        return <FinancialProfile />;
      case 'accounts':
        return <LinkedAccounts />;
      case 'history':
        return <ChatHistory />;
      case 'documents':
        return <Documents />;
      case 'cases':
        return <Cases />;
      case 'notifications':
        return <Notifications onAsk={onAsk} />;
      case 'consents':
        return <Consents />;
      case 'privacy':
        return <Privacy />;
      case 'services':
        return <ConnectedServices integrations={integrations} />;
      case 'permissions':
        return <DataPermissions />;
      case 'language':
        return <Language />;
      case 'theme':
        return <ThemeSection theme={theme} onTheme={onTheme} />;
      case 'notification-prefs':
        return <NotificationPrefs />;
      case 'help':
        return <Help onAsk={onAsk} />;
      case 'faqs':
        return <Faqs />;
      case 'about':
        return <About />;
    }
  };

  return (
    <main className={`page more ${current ? 'has-section' : ''}`}>
      <nav className="more-menu" aria-label="More">
        <div className="more-profile">
          <span className="avatar avatar-lg">{user.display_name.slice(0, 1)}</span>
          <div>
            <strong>{user.display_name}</strong>
            <small className="muted">Paytm customer</small>
          </div>
        </div>
        {GROUPS.map((group) => (
          <section key={group.title}>
            <h2>{group.title}</h2>
            <ul>
              {group.items.map((item) => (
                <li key={item.id}>
                  <a href={routeHref('more', item.id)} className={current?.id === item.id ? 'active' : ''} aria-current={current?.id === item.id ? 'page' : undefined}>
                    <Icon name={item.icon} size={18} />
                    <span>{item.label}</span>
                    <Icon name="next" size={16} className="chev" />
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ))}
        <button className="btn btn-ghost danger btn-block" onClick={onLogout}>
          <Icon name="logout" size={18} /> Sign out
        </button>
      </nav>
      <section className="more-content card">
        {current ? (
          <>
            <header className="more-head">
              <a className="icon-btn back-link" href={routeHref('more')} aria-label="Back to More">
                <Icon name="back" />
              </a>
              <h1>{current.label}</h1>
            </header>
            {content(current.id)}
          </>
        ) : (
          <EmptyState icon="grid" title="Settings and help" body="Choose a section to view your profile, privacy, preferences, and support options." />
        )}
      </section>
    </main>
  );
}
