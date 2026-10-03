import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { EVENT_LABELS, LANGUAGES, STATUS_LABELS } from '../format';
import type { CaseRecord, IntegrationStatus } from '../types';
import { MicButton, SpeakButton } from '../components/Voice';
import { Icon } from './Icon';
import { JOURNEYS } from './MobileHome';

type Sheet = { kind: 'records'; message: string } | { kind: 'ai'; message: string } | { kind: 'voice' } | null;

interface Props {
  integrations: IntegrationStatus;
  activeCase: CaseRecord | null;
  onCase: (record: CaseRecord | null) => void;
  onOpenCase: () => void;
  seed: { text: string; nonce: number } | null;
  onSeedUsed: () => void;
}

const SUGGESTIONS = [
  { label: 'Hospital bill', message: JOURNEYS.hospital },
  { label: 'Payment I didn\'t make', message: JOURNEYS.fraud },
  { label: 'Refund not received', message: JOURNEYS.refund },
  { label: 'Short for EMI', message: JOURNEYS.emi },
];

const readLanguage = () => {
  try {
    return localStorage.getItem('saathi.language') ?? '';
  } catch {
    return '';
  }
};

export function MobileSaathi({ integrations, activeCase, onCase, onOpenCase, seed, onSeedUsed }: Props) {
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [aiConsent, setAiConsent] = useState(false);
  const [language, setLanguage] = useState(readLanguage);
  const endRef = useRef<HTMLDivElement>(null);
  const followUp = Boolean(activeCase && integrations.openai_available);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeCase?.messages.length, busy]);

  const startCase = async (message: string, consent: boolean) => {
    setSheet(null);
    setBusy(true);
    setError(null);
    try {
      onCase(await api.createCase(message, consent, language || undefined));
      setDraft('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not start the case. Nothing was shared.');
    } finally {
      setBusy(false);
    }
  };

  const askFollowUp = async (message: string) => {
    if (!activeCase) return;
    setSheet(null);
    setBusy(true);
    setError(null);
    try {
      onCase(await api.chat(activeCase.case_id, message, language || undefined));
      setDraft('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Saathi could not answer. Your case is unchanged.');
    } finally {
      setBusy(false);
    }
  };

  const send = (text: string, forceNew = false) => {
    const message = text.trim();
    if (!message || busy) return;
    if (followUp && !forceNew) {
      if (aiConsent) void askFollowUp(message);
      else setSheet({ kind: 'ai', message });
      return;
    }
    if (message.length < 8) {
      setError('Tell Saathi a little more, for example what happened and the amount.');
      return;
    }
    setSheet({ kind: 'records', message });
  };

  useEffect(() => {
    if (!seed) return;
    onCase(null);
    send(seed.text, true);
    onSeedUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed]);

  const lastAssistant = activeCase?.messages.filter((message) => message.role === 'assistant').at(-1);
  const ready = activeCase && (activeCase.decision || activeCase.pending_question);

  return (
    <div className="m-chat">
      <header className="m-topbar">
        <div>
          <strong>Saathi</strong>
          <small>{activeCase ? EVENT_LABELS[activeCase.event_type] : 'Your money companion'}</small>
        </div>
        <select
          className="m-lang"
          value={language}
          onChange={(event) => {
            setLanguage(event.target.value);
            try {
              localStorage.setItem('saathi.language', event.target.value);
            } catch {
              // convenience only
            }
          }}
          aria-label="Language"
        >
          {LANGUAGES.map((item) => (
            <option key={item.code} value={item.code}>
              {item.code ? item.label.split(' ').at(-1) : 'Auto'}
            </option>
          ))}
        </select>
        {activeCase && (
          <button className="m-icon-btn dark" onClick={() => onCase(null)} aria-label="New conversation">
            <Icon name="plus" />
          </button>
        )}
      </header>

      <div className="m-messages">
        {!activeCase && (
          <div className="m-welcome">
            <span className="m-welcome-icon">
              <Icon name="sparkle" size={28} />
            </span>
            <h2>What happened?</h2>
            <p>Speak or type in your language. Saathi finds the safest way forward.</p>
            <div className="m-suggestions">
              {SUGGESTIONS.map((suggestion) => (
                <button key={suggestion.label} onClick={() => send(suggestion.message, true)}>
                  {suggestion.label}
                </button>
              ))}
            </div>
          </div>
        )}
        {activeCase?.messages.map((message, index) => (
          <div key={`${message.at}-${index}`} className={`m-bubble ${message.role}`}>
            <p>{message.content}</p>
            {message.role === 'assistant' && integrations.sarvam_available && (
              <SpeakButton text={message.content} language={message.language || language || activeCase.preferred_language || 'en-IN'} />
            )}
          </div>
        ))}
        {busy && <div className="m-bubble assistant typing">Saathi is checking your records…</div>}
        {ready && !busy && (
          <button className="m-case-card" onClick={onOpenCase}>
            <span>
              <small>{STATUS_LABELS[activeCase!.status]}</small>
              <strong>{activeCase!.pending_question ? 'Choose an option to continue' : 'Your plan is ready'}</strong>
            </span>
            <span className="m-case-cta">
              Open <Icon name="next" size={16} />
            </span>
          </button>
        )}
        {activeCase && activeCase.status === 'intake' && !busy && (
          <button className="m-case-card warn" onClick={onOpenCase}>
            <span>
              <small>Waiting for you</small>
              <strong>Allow access to continue</strong>
            </span>
            <span className="m-case-cta">
              Open <Icon name="next" size={16} />
            </span>
          </button>
        )}
        {lastAssistant && <span className="sr-only" aria-live="polite">{lastAssistant.content}</span>}
        <div ref={endRef} />
      </div>

      {error && <p className="m-error inline">{error}</p>}

      <div className="m-composer">
        <MicButton
          available={integrations.sarvam_available}
          consent={voiceConsent}
          language={language}
          disabled={busy}
          onTranscript={(text) => setDraft((current) => (current ? `${current} ${text}` : text))}
          onError={(message) => (message.includes('Allow voice') || message.includes('Tick') ? setSheet({ kind: 'voice' }) : setError(message))}
        />
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && send(draft)}
          placeholder={followUp ? 'Ask about this case…' : 'Type what happened…'}
          maxLength={1000}
        />
        <button className="m-send" disabled={busy || !draft.trim()} onClick={() => send(draft)} aria-label="Send">
          <Icon name="send" size={20} />
        </button>
      </div>

      {sheet && (
        <div className="m-sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="m-sheet" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <span className="m-sheet-handle" />
            <span className="m-sheet-icon">
              <Icon name={sheet.kind === 'voice' ? 'mic' : sheet.kind === 'ai' ? 'sparkle' : 'lock'} size={26} />
            </span>
            {sheet.kind === 'records' && (
              <>
                <h3>Allow Saathi to read your records?</h3>
                <p>Only for this case: your bill, policy and account details. You can revoke it anytime.</p>
                <button className="m-btn primary" onClick={() => void startCase(sheet.message, true)}>
                  Allow and continue
                </button>
                <button className="m-btn ghost" onClick={() => void startCase(sheet.message, false)}>
                  Not now
                </button>
              </>
            )}
            {sheet.kind === 'ai' && (
              <>
                <h3>Let Saathi AI answer?</h3>
                <p>Your question and this case's facts go to OpenAI, with contact details removed. It can't change numbers.</p>
                <button className="m-btn primary" onClick={() => { setAiConsent(true); void askFollowUp(sheet.message); }}>
                  Allow
                </button>
                <button className="m-btn ghost" onClick={() => setSheet(null)}>
                  Cancel
                </button>
              </>
            )}
            {sheet.kind === 'voice' && (
              <>
                <h3>Use your voice?</h3>
                <p>Your recording goes to Sarvam to turn speech into text. It isn't stored.</p>
                <button className="m-btn primary" onClick={() => { setVoiceConsent(true); setSheet(null); }}>
                  Allow microphone
                </button>
                <button className="m-btn ghost" onClick={() => setSheet(null)}>
                  Cancel
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
