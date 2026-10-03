import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { EVENT_LABELS, inr, LANGUAGES, STATUS_LABELS } from '../format';
import type { CaseRecord, CaseSummary, IntegrationStatus, SessionUser, StandingConsents } from '../types';
import { MicButton, SpeakButton } from '../components/Voice';
import { Icon } from './Icon';

type Sheet = { kind: 'records'; message: string } | { kind: 'ai'; message: string } | { kind: 'voice' } | null;

interface Props {
  user: SessionUser;
  integrations: IntegrationStatus;
  activeCase: CaseRecord | null;
  onCase: (record: CaseRecord | null) => void;
  onOpenCase: () => void;
  topic: { hint: string; nonce: number } | null;
  onTopicUsed: () => void;
}

const readLanguage = () => {
  try {
    return localStorage.getItem('saathi.language') ?? '';
  } catch {
    return '';
  }
};

const dayLabel = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

export function MobileSaathi({ user, integrations, activeCase, onCase, onOpenCase, topic, onTopicUsed }: Props) {
  const [draft, setDraft] = useState('');
  const [placeholder, setPlaceholder] = useState('Message Saathi…');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [remember, setRemember] = useState(true);
  const [consents, setConsents] = useState<StandingConsents>({ records: false, ai: false, voice: false });
  const [voiceOnce, setVoiceOnce] = useState(false);
  const [history, setHistory] = useState<CaseSummary[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [language, setLanguage] = useState(readLanguage);
  const [pendingUser, setPendingUser] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const followUp = Boolean(activeCase && integrations.openai_available);

  const loadHistory = useCallback(() => {
    api
      .listCases()
      .then((result) => setHistory(result.cases))
      .catch(() => setHistory([]));
  }, []);

  useEffect(() => {
    api.consents().then(setConsents).catch(() => undefined);
    loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [activeCase?.messages.length, busy, pendingUser]);

  // A service tile opens a fresh chat with a topic-specific prompt; the customer types their own details.
  useEffect(() => {
    if (!topic) return;
    onCase(null);
    setPlaceholder(topic.hint);
    setDraft('');
    setTimeout(() => inputRef.current?.focus(), 50);
    onTopicUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [topic]);

  const rememberChoice = async (choice: Partial<StandingConsents>) => {
    if (!remember) return;
    try {
      setConsents(await api.setConsents(choice));
    } catch {
      // the case still records its own consent
    }
  };

  const startCase = async (message: string, consent: boolean) => {
    setSheet(null);
    setBusy(true);
    setError(null);
    setPendingUser(message);
    try {
      onCase(await api.createCase(message, consent, language || undefined));
      setDraft('');
      setPlaceholder('Ask a follow-up…');
      loadHistory();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not send that. Nothing was shared.');
    } finally {
      setBusy(false);
      setPendingUser(null);
    }
  };

  const askFollowUp = async (message: string) => {
    if (!activeCase) return;
    setSheet(null);
    setBusy(true);
    setError(null);
    setPendingUser(message);
    try {
      onCase(await api.chat(activeCase.case_id, message, language || undefined));
      setDraft('');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Saathi could not answer. Your case is unchanged.');
    } finally {
      setBusy(false);
      setPendingUser(null);
    }
  };

  const send = (text: string) => {
    const message = text.trim();
    if (!message || busy) return;
    if (followUp) {
      if (consents.ai) void askFollowUp(message);
      else setSheet({ kind: 'ai', message });
      return;
    }
    if (message.length < 4) {
      setError('Tell Saathi a little more about what happened.');
      return;
    }
    if (consents.records) void startCase(message, true);
    else setSheet({ kind: 'records', message });
  };

  const openFromHistory = async (caseId: string) => {
    setShowHistory(false);
    try {
      onCase(await api.getCase(caseId));
      setPlaceholder('Ask a follow-up…');
    } catch {
      setError('Could not open that chat.');
    }
  };

  const removeFromHistory = async (caseId: string) => {
    try {
      await api.deleteCase(caseId);
      setHistory((current) => current.filter((item) => item.case_id !== caseId));
      if (activeCase?.case_id === caseId) onCase(null);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not delete that chat.');
    }
  };

  const confirm = async (transactionId: string, recognized: boolean) => {
    if (!activeCase) return;
    setBusy(true);
    setError(null);
    try {
      onCase(await api.confirmTransaction(activeCase.case_id, transactionId, recognized));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not record that. Nothing was filed.');
    } finally {
      setBusy(false);
    }
  };

  const newChat = () => {
    onCase(null);
    setPlaceholder('Message Saathi…');
    setDraft('');
    setError(null);
    setShowHistory(false);
  };

  const ready = activeCase && (activeCase.decision || activeCase.pending_question) && activeCase.status !== 'intake';
  const txnQuestion = activeCase?.pending_question?.type === 'confirm_transaction' ? activeCase.pending_question : null;
  const firstName = user.display_name.replace(' (demo)', '').split(' ')[0];

  return (
    <div className="m-chat">
      <header className="m-topbar">
        <button className="m-icon-btn dark" onClick={() => { loadHistory(); setShowHistory(true); }} aria-label="Chat history">
          <Icon name="history" />
        </button>
        <div>
          <strong>Saathi</strong>
          <small>{activeCase ? EVENT_LABELS[activeCase.event_type] : 'New chat'}</small>
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
        <button className="m-icon-btn dark" onClick={newChat} aria-label="New chat">
          <Icon name="plus" />
        </button>
      </header>

      <div className="m-messages">
        {!activeCase && !pendingUser && (
          <div className="m-welcome">
            <span className="m-welcome-icon">
              <Icon name="sparkle" size={28} />
            </span>
            <h2>Hi {firstName}, how can I help?</h2>
            <p>Type or tap the mic and speak in your language.</p>
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
        {pendingUser && <div className="m-bubble user">{pendingUser}</div>}
        {busy && <div className="m-bubble assistant typing">Saathi is thinking…</div>}
        {txnQuestion && !busy && (
          <div className="m-choices" role="group" aria-label={txnQuestion.prompt}>
            {txnQuestion.candidates.map((transaction) => (
              <div key={transaction.transaction_id} className={`m-choice ${transaction.recognized_device ? '' : 'flag'}`}>
                <div>
                  <strong>
                    {inr(transaction.amount_inr)} · {transaction.counterparty}
                  </strong>
                  <small>
                    {dayLabel(transaction.occurred_at)} · {transaction.device}
                    {transaction.first_time_counterparty ? ' · First-time payee' : ''}
                  </small>
                </div>
                {txnQuestion.mode === 'select' ? (
                  <button className="m-btn primary small" onClick={() => confirm(transaction.transaction_id, false)}>
                    This one
                  </button>
                ) : (
                  <span className="m-choice-actions">
                    <button className="m-btn danger small" onClick={() => confirm(transaction.transaction_id, false)}>
                      Not me
                    </button>
                    <button className="m-btn ghost small" onClick={() => confirm(transaction.transaction_id, true)}>
                      This was me
                    </button>
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
        {ready && !busy && !txnQuestion && (
          <button className="m-case-card" onClick={onOpenCase}>
            <span>
              <small>{STATUS_LABELS[activeCase!.status]}</small>
              <strong>{activeCase!.pending_question ? 'Choose an option to continue' : 'See your plan'}</strong>
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
        <div ref={endRef} />
      </div>

      {error && <p className="m-error inline">{error}</p>}

      <div className="m-composer">
        <MicButton
          available={integrations.sarvam_available}
          consent={consents.voice || voiceOnce}
          language={language}
          disabled={busy}
          onTranscript={(text) => send(text)}
          onError={(message) => (message.includes('Allow voice') || message.includes('Tick') ? setSheet({ kind: 'voice' }) : setError(message))}
        />
        <input
          ref={inputRef}
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => event.key === 'Enter' && send(draft)}
          placeholder={placeholder}
          maxLength={1000}
        />
        <button className="m-send" disabled={busy || !draft.trim()} onClick={() => send(draft)} aria-label="Send">
          <Icon name="send" size={20} />
        </button>
      </div>

      {showHistory && (
        <div className="m-sheet-backdrop" onClick={() => setShowHistory(false)}>
          <aside className="m-drawer" onClick={(event) => event.stopPropagation()} aria-label="Chat history">
            <div className="m-drawer-head">
              <strong>Chats</strong>
              <button className="m-btn primary small" onClick={newChat}>
                <Icon name="plus" size={16} /> New chat
              </button>
            </div>
            {history.length === 0 && <p className="m-muted small">No chats yet.</p>}
            <ul className="m-history">
              {history.map((item) => (
                <li key={item.case_id} className={activeCase?.case_id === item.case_id ? 'active' : ''}>
                  <button className="m-history-open" onClick={() => void openFromHistory(item.case_id)}>
                    <strong>{item.customer_message}</strong>
                    <small>
                      {EVENT_LABELS[item.event_type]} · {dayLabel(item.updated_at)}
                    </small>
                  </button>
                  <button className="m-history-delete" onClick={() => void removeFromHistory(item.case_id)} aria-label="Delete chat">
                    <Icon name="trash" size={17} />
                  </button>
                </li>
              ))}
            </ul>
          </aside>
        </div>
      )}

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
                <p>Saathi uses your bills, policies and account details only to help with this request.</p>
                <label className="m-remember">
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Don't ask me again
                </label>
                <button className="m-btn primary" onClick={() => { void rememberChoice({ records: true }); void startCase(sheet.message, true); }}>
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
                <p>Your question and this case's facts are sent to the AI with contact details removed. It can't change numbers.</p>
                <label className="m-remember">
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Don't ask me again
                </label>
                <button className="m-btn primary" onClick={() => { void rememberChoice({ ai: true }); setConsents((current) => ({ ...current, ai: true })); void askFollowUp(sheet.message); }}>
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
                <p>Your recording is turned into text and sent to Saathi. It isn't stored.</p>
                <label className="m-remember">
                  <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} /> Don't ask me again
                </label>
                <button className="m-btn primary" onClick={() => { void rememberChoice({ voice: true }); setVoiceOnce(true); setSheet(null); }}>
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
