import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { EVENT_LABELS, STATUS_LABELS } from '../format';
import type { CaseRecord, CaseSummary, IntegrationStatus } from '../types';
import { VoiceNote } from './VoiceNote';

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
  onSubmit: (message: string, consent: boolean) => Promise<void>;
  onOpenCase: (caseId: string) => void;
  onNewCase: () => void;
}

export function Conversation({ activeCase, cases, busy, error, integrations, onSubmit, onOpenCase, onNewCase }: Props) {
  const [draft, setDraft] = useState('');
  const [consent, setConsent] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  const messages = activeCase?.messages ?? [
    { role: 'assistant' as const, content: 'Tell me what happened, or open one of the demo journeys below.', at: '' },
  ];

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [messages.length]);

  const send = async (message: string) => {
    const text = message.trim();
    if (text.length < 8 || busy) return;
    await onSubmit(text, consent);
    setDraft('');
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void send(draft);
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
            <p>{message.content}</p>
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

      <div className="composer">
        <textarea
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Papa hospital mein hain... what happened?"
          rows={2}
          maxLength={2000}
        />
        <button className="btn btn-primary" disabled={busy || draft.trim().length < 8} onClick={() => void send(draft)}>
          Start case
        </button>
      </div>
      <p className="muted small">Each message opens a new case. Use synthetic details only.</p>

      <VoiceNote available={integrations.sarvam_available} disabled={busy} onTranscript={(text) => setDraft(text)} />
    </section>
  );
}
