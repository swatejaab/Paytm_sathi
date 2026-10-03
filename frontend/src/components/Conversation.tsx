import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EVENT_LABELS, LANGUAGES, STATUS_LABELS } from '../format';
import type { CaseRecord, CaseSummary, IntegrationStatus } from '../types';
import { AlertsPanel } from './AlertsPanel';
import { MicButton, SpeakButton } from './Voice';

const DEMOS = [
  {
    label: 'Hospital demo',
    icon: '🏥',
    message: 'Papa hospital mein hain. Bill INR 80,000 hai. Insurance hai, ab kya karun?',
  },
  {
    label: 'Unrecognized UPI',
    icon: '⚠️',
    message: 'Mere account se INR 8,500 ka UPI payment hua jo maine nahi kiya. Kya karun?',
  },
  {
    label: 'EMI shortfall',
    icon: '📅',
    message: 'Salary delayed hai, is mahine EMI bharne ke paise kam hain. Kya options hain?',
  },
];

interface Props {
  activeCase: CaseRecord | null;
  cases: CaseSummary[];
  busy: boolean;
  error: string | null;
  integrations: IntegrationStatus;
  onSubmit: (message: string, consent: boolean, language: string) => Promise<void>;
  onAsk: (message: string, language: string) => Promise<void>;
  onOpenCase: (caseId: string) => void;
  onNewCase: () => void;
  seed?: { text: string; nonce: number } | null;
}

const readPref = (key: string, fallback: string) => {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
};
const writePref = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    // preferences are a convenience only
  }
};

export function Conversation({ activeCase, cases, busy, error, integrations, onSubmit, onAsk, onOpenCase, onNewCase, seed }: Props) {
  const [draft, setDraft] = useState('');
  const [consent, setConsent] = useState(false);
  const [language, setLanguage] = useState(() => readPref('saathi.language', ''));
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const followUp = Boolean(activeCase && integrations.openai_available);
  const speakLanguage = (message: { language?: string }) =>
    message.language || language || activeCase?.preferred_language || 'en-IN';
  const endRef = useRef<HTMLDivElement>(null);

  // A question started on the Home screen lands here as a draft, so the customer still chooses consent and sends it.
  useEffect(() => {
    if (seed) setDraft(seed.text);
  }, [seed]);

  const messages = activeCase?.messages ?? [
    { role: 'assistant' as const, content: 'Tell me what happened, or open one of the demo journeys below.', at: '' },
  ];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length]);

  const send = async (message: string) => {
    const text = message.trim();
    if (text.length < 8 || busy) return;
    setNotice(null);
    await onSubmit(text, consent, language);
    setDraft('');
  };

  const ask = async () => {
    const text = draft.trim();
    if (text.length < 2 || busy) return;
    if (!aiConsent) {
      setNotice('Tick "Allow Saathi AI to answer from my case facts" to ask follow-up questions.');
      return;
    }
    setNotice(null);
    await onAsk(text, language);
    setDraft('');
  };

  const submitDraft = () => void (followUp ? ask() : send(draft));

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      submitDraft();
    }
  };

  return (
    <section className="conversation">
      <div className="conversation-head">
        <div>
          <p className="eyebrow">Life happened?</p>
          <h1>Tell Saathi what happened.</h1>
          <p className="muted">One conversation. Evidence-backed next steps. You stay in control.</p>
        </div>
        <div className="case-switcher">
          <select
            value={language}
            onChange={(event) => {
              setLanguage(event.target.value);
              writePref('saathi.language', event.target.value);
            }}
            aria-label="Conversation language"
            title="Saathi listens, replies, and speaks in this language"
          >
            {LANGUAGES.map((item) => (
              <option key={item.code} value={item.code}>
                {item.label}
              </option>
            ))}
          </select>
          <select
            value={activeCase?.case_id ?? ''}
            onChange={(event) => (event.target.value ? onOpenCase(event.target.value) : onNewCase())}
            aria-label="Open a previous case"
          >
            <option value="">New case</option>
            {cases.map((item) => (
              <option key={item.case_id} value={item.case_id}>
                {item.case_id} / {EVENT_LABELS[item.event_type]} / {STATUS_LABELS[item.status]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="demo-buttons">
        {DEMOS.map((demo) => (
          <button key={demo.label} className="btn btn-demo" disabled={busy} onClick={() => void send(demo.message)}>
            <span aria-hidden>{demo.icon}</span> {demo.label}
          </button>
        ))}
      </div>

      <AlertsPanel busy={busy} onStart={(message) => void send(message)} refreshKey={`${activeCase?.case_id ?? ''}:${cases.length}`} />

      <label className="consent-box">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
        <span>
          <strong>Allow Saathi to read my case records</strong>
          <small>
            Purpose: prepare resolution options. Saathi reads the synthetic policy, bill, and account records for this case only.
            You can revoke it at any time. Without it, the case is saved but nothing is read.
          </small>
        </span>
      </label>

      <div className="messages" aria-live="polite">
        {messages.map((message, index) => (
          <div key={`${message.at}-${index}`} className={`message message-${message.role}`}>
            <span className="avatar" aria-hidden>
              {message.role === 'assistant' ? 'S' : 'You'}
            </span>
            <div className="message-body">
              <p>{message.content}</p>
              {message.role === 'assistant' && (
                <div className="message-meta">
                  {integrations.sarvam_available && <SpeakButton text={message.content} language={speakLanguage(message)} />}
                  {message.source === 'openai' && <small className="muted">AI answer from your case facts</small>}
                  {message.original && (
                    <details className="original">
                      <summary>Original (English)</summary>
                      <small>{message.original}</small>
                    </details>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
        {busy && (
          <div className="message message-assistant">
            <span className="avatar">S</span>
            <p className="typing">Saathi is gathering evidence through the MCP gateway...</p>
          </div>
        )}
        <div ref={endRef} />
      </div>

      {error && <p className="alert alert-error">{error}</p>}
      {notice && <p className="alert alert-warn">{notice}</p>}

      <div className="composer">
        <MicButton
          available={integrations.sarvam_available}
          consent={voiceConsent}
          language={language}
          disabled={busy}
          onTranscript={(text) => setDraft((current) => (current ? current + ' ' + text : text))}
          onError={setNotice}
        />
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={followUp ? 'Ask about this case, e.g. "Why is this plan recommended?"' : 'Papa hospital mein hain... what happened?'}
          rows={2}
          maxLength={2000}
        />
        <button className="btn btn-primary" disabled={busy || draft.trim().length < (followUp ? 2 : 8)} onClick={submitDraft}>
          {followUp ? 'Ask Saathi' : 'Start case'}
        </button>
      </div>
      <div className="voice-consents">
        {integrations.sarvam_available && (
          <label className="checkbox">
            <input type="checkbox" checked={voiceConsent} onChange={(event) => setVoiceConsent(event.target.checked)} />
            Allow voice processing by Sarvam (speech-to-text and read-aloud). Audio is not stored.
          </label>
        )}
        {followUp && (
          <label className="checkbox">
            <input type="checkbox" checked={aiConsent} onChange={(event) => setAiConsent(event.target.checked)} />
            Allow Saathi AI (OpenAI) to answer from my case facts. Contact details are redacted; it cannot change numbers or approve anything.
          </label>
        )}
      </div>
      <p className="muted small">
        {followUp
          ? 'Questions go to this case. Choose "New case" above to start another. Use synthetic details only.'
          : 'Each message opens a new case. Use synthetic details only.'}
      </p>
    </section>
  );
}
