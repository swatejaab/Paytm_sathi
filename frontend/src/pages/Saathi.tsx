import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage, streamCase } from '../api';
import { CasePanel, type PanelTab } from '../components/CasePanel';
import { Composer, type DocumentKind } from '../components/chat/Composer';
import { HistoryPanel } from '../components/chat/HistoryPanel';
import { MessageCard } from '../components/chat/MessageCard';
import { BrandMark, Icon } from '../components/Icon';
import { SOS_PARAM, SosEmpty } from '../components/MoneySos';
import { ConfirmDialog, ErrorState, Loading, Modal } from '../components/ui';
import { dateTime, inr, readPref, STATUS_LABELS, writePref } from '../format';
import { navigate } from '../router';
import { useToast } from '../toast';
import type { CaseRecord, CaseSummary, ChatMessage, GoalInput, GoalType, IntegrationStatus, QuickReply, Transaction } from '../types';
import { browserVoiceSupported, recorderAvailable } from '../voice';

const SUGGESTIONS = [
  { icon: 'hospital', text: 'Papa ICU mein hai, ₹80,000 deposit maang rahe hain. Kya karun?' },
  { icon: 'alert', text: "I don't recognise a UPI payment of ₹8,500." },
  { icon: 'calendar', text: 'Mera EMI Friday ko hai lekin salary Monday ko aayegi.' },
  { icon: 'wallet', text: 'Can I afford an iPhone for ₹1 lakh?' },
  { icon: 'target', text: 'I want to save ₹10 lakh for a car by December 2028.' },
  { icon: 'insights', text: 'How much did I spend this month?' },
] as const;

type ReplyState = 'loading' | 'done' | 'error';

interface Props {
  integrations: IntegrationStatus;
  routeParam: string | null;
  seed: { text: string; nonce: number } | null;
  onSeedUsed: () => void;
}

function toGoalInput(payload: Record<string, unknown> | undefined): GoalInput {
  return {
    name: String(payload?.name ?? 'My goal'),
    type: (payload?.type as GoalType) ?? 'custom',
    target_inr: Number(payload?.target_inr ?? 0),
    target_date: (payload?.target_date as string | null) ?? null,
    current_savings_inr: Number(payload?.current_savings_inr ?? 0),
    monthly_contribution_inr: payload?.monthly_contribution_inr == null ? null : Number(payload.monthly_contribution_inr),
    priority: 'medium',
  };
}

let currentAudio: HTMLAudioElement | null = null;

function ListenButton({ text, language }: { text: string; language: string }) {
  const [state, setState] = useState<'idle' | 'loading' | 'error'>('idle');
  const play = async () => {
    setState('loading');
    try {
      const result = await api.speak(text.slice(0, 1500), language || 'en-IN');
      currentAudio?.pause();
      currentAudio = new Audio(`data:${result.mime_type};base64,${result.audio_base64}`);
      await currentAudio.play();
      setState('idle');
    } catch {
      setState('error');
    }
  };
  return (
    <button className="msg-tool" onClick={() => void play()} disabled={state === 'loading'} aria-label="Listen to this message" title={state === 'error' ? "Couldn't play audio. Try again." : 'Listen'}>
      <Icon name={state === 'error' ? 'alert' : 'volume'} size={14} />
      {state === 'loading' ? 'Loading...' : 'Listen'}
    </button>
  );
}

function ReportModal({ transaction, onClose, onDispute }: { transaction: Transaction | null; onClose: () => void; onDispute: (() => void) | null }) {
  const toast = useToast();
  const details = transaction
    ? [
        `Transaction ID: ${transaction.transaction_id}`,
        `Amount: ${inr(transaction.amount_inr)}`,
        `Paid to: ${transaction.counterparty}${transaction.counterparty_vpa ? ` (${transaction.counterparty_vpa})` : ''}`,
        `Date and time: ${dateTime(transaction.occurred_at)}`,
        `Channel: ${transaction.channel}`,
      ].join('\n')
    : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(details);
      toast('Transaction details copied', 'success');
    } catch {
      toast("Couldn't copy automatically. Please select the details and copy them.", 'error');
    }
  };
  return (
    <Modal title="Report this transaction" onClose={onClose}>
      {transaction ? <pre className="report-details">{details}</pre> : <p className="muted">Saathi hasn't identified the payment yet.</p>}
      <ol className="steps-list">
        <li>
          Call the national cyber fraud helpline <strong>1930</strong> as soon as possible. Quick reporting improves the chance of recovery.
        </li>
        <li>File a complaint at cybercrime.gov.in with the details above.</li>
        <li>Raise a dispute in Paytm so the bank can investigate. Saathi can prepare it for your approval.</li>
      </ol>
      <div className="row gap-sm wrap">
        {transaction && (
          <button className="btn" onClick={() => void copy()}>
            Copy details
          </button>
        )}
        <a className="btn" href="tel:1930">
          Call 1930
        </a>
        <a className="btn" href="https://cybercrime.gov.in" target="_blank" rel="noopener noreferrer">
          Open cybercrime.gov.in
        </a>
        {onDispute && (
          <button
            className="btn btn-primary"
            onClick={() => {
              onClose();
              onDispute();
            }}
          >
            Raise dispute
          </button>
        )}
      </div>
    </Modal>
  );
}

function MessageBody({ text }: { text: string }) {
  return <div className="msg-text">{text}</div>;
}

// A reply translated into the customer's language can be checked against the English Saathi wrote.
function TranslatedBody({ message }: { message: ChatMessage }) {
  const [showOriginal, setShowOriginal] = useState(false);
  if (!message.original) return <MessageBody text={message.content} />;
  return (
    <>
      <MessageBody text={showOriginal ? message.original : message.content} />
      <button className="msg-lang-toggle" onClick={() => setShowOriginal(!showOriginal)}>
        {showOriginal ? 'Show translation' : 'Show in English'}
      </button>
    </>
  );
}

export function Saathi({ integrations, routeParam, seed, onSeedUsed }: Props) {
  const toast = useToast();
  const [language, setLanguageState] = useState(() => readPref('saathi.language', ''));
  const setLanguage = (next: string) => {
    setLanguageState(next);
    writePref('saathi.language', next);
  };
  const [conversations, setConversations] = useState<CaseSummary[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [active, setActiveState] = useState<CaseRecord | null>(null);
  const activeRef = useRef<CaseRecord | null>(null);
  const [caseLoading, setCaseLoading] = useState(false);
  const [caseError, setCaseError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [pending, setPending] = useState<{ text: string; base: number } | null>(null);
  const [indicator, setIndicator] = useState<'thinking' | 'reading' | null>(null);
  const [failure, setFailure] = useState<{ message: string; retry: () => void } | null>(null);
  const [panel, setPanel] = useState<PanelTab | null>(null);
  const [replyStates, setReplyStates] = useState<Record<string, ReplyState>>({});
  const [busy, setBusy] = useState(false);
  const [attachRequest, setAttachRequest] = useState<{ kind: DocumentKind; nonce: number } | null>(null);
  const [voiceRequest, setVoiceRequest] = useState<number | null>(null);
  const [callingBack, setCallingBack] = useState(false);
  const [voiceConsent, setVoiceConsent] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [photo, setPhoto] = useState<{ kind: DocumentKind; file: File } | null>(null);
  const [queued, setQueued] = useState<string | null>(seed?.text ?? null);
  const seqRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement>(null);

  const setActive = useCallback((record: CaseRecord | null) => {
    activeRef.current = record;
    setActiveState(record);
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      setConversations((await api.listCases()).cases);
      setHistoryError(null);
    } catch (caught) {
      setHistoryError(errorMessage(caught));
    } finally {
      setHistoryLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshHistory();
    api
      .consents()
      .then((consents) => setVoiceConsent(consents.voice))
      .catch(() => setVoiceConsent(false));
  }, [refreshHistory]);

  useEffect(() => {
    if (seed) onSeedUsed();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Route drives which conversation is open; "new" and the bare route show an empty chat.
  useEffect(() => {
    setHistoryOpen(false);
    if (!routeParam || routeParam === 'new' || routeParam === SOS_PARAM) {
      if (routeParam === 'new') navigate('saathi', null, { replace: true });
      seqRef.current += 1;
      setActive(null);
      setPanel(null);
      setFailure(null);
      setPending(null);
      setIndicator(null);
      setCaseError(null);
      setReplyStates({});
      return;
    }
    if (activeRef.current?.case_id === routeParam) return;
    seqRef.current += 1;
    setPanel(null);
    setFailure(null);
    setPending(null);
    setReplyStates({});
    setCaseLoading(true);
    setCaseError(null);
    let cancelled = false;
    api
      .getCase(routeParam)
      .then((record) => !cancelled && setActive(record))
      .catch((caught) => !cancelled && setCaseError(errorMessage(caught)))
      .finally(() => !cancelled && setCaseLoading(false));
    return () => {
      cancelled = true;
    };
  }, [routeParam, setActive]);

  const send = useCallback(
    async (text: string, conversationId: string | null = activeRef.current?.case_id ?? null) => {
      const seq = ++seqRef.current;
      setFailure(null);
      setPending({ text, base: conversationId ? (activeRef.current?.messages.length ?? 0) : 0 });
      setIndicator('thinking');
      try {
        const record = await api.chat(text, conversationId, language || undefined);
        if (seq !== seqRef.current) return;
        setActive(record);
        setPending(null);
        if (!conversationId) navigate('saathi', record.case_id, { replace: true });
        void refreshHistory();
      } catch (caught) {
        if (seq !== seqRef.current) return;
        setFailure({ message: errorMessage(caught), retry: () => void send(text, conversationId) });
      } finally {
        if (seq === seqRef.current) setIndicator(null);
      }
    },
    [language, refreshHistory, setActive],
  );

  useEffect(() => {
    if (!queued || (routeParam && routeParam !== SOS_PARAM)) return;
    setQueued(null);
    void send(queued, null);
  }, [queued, routeParam, send]);

  const caseId = active?.case_id;
  const status = active?.status;
  const [live, setLive] = useState(false);
  useEffect(() => {
    if (!caseId) return;
    const controller = new AbortController();
    setLive(true);
    streamCase(
      caseId,
      (record) => {
        if (record.case_id === activeRef.current?.case_id && record.updated_at >= (activeRef.current?.updated_at ?? '')) setActive(record);
      },
      controller.signal,
    )
      .catch(() => undefined)
      .finally(() => setLive(false));
    return () => controller.abort();
  }, [caseId, setActive]);

  useEffect(() => {
    if (live || !caseId || status !== 'in_progress') return;
    const timer = window.setInterval(async () => {
      try {
        const record = await api.getCase(caseId);
        if (record.case_id === activeRef.current?.case_id) setActive(record);
      } catch {
        // the next tick retries
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [live, caseId, status, setActive]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const hasContent = Boolean(active?.messages.length || pending || indicator || failure);
    element.scrollTo({ top: hasContent ? element.scrollHeight : 0, behavior: hasContent ? 'smooth' : 'auto' });
  }, [active?.messages.length, pending, indicator, failure]);

  const run = useCallback(
    async (operation: () => Promise<CaseRecord>) => {
      setBusy(true);
      try {
        setActive(await operation());
        void refreshHistory();
      } catch (caught) {
        toast(errorMessage(caught), 'error');
      } finally {
        setBusy(false);
      }
    },
    [refreshHistory, setActive, toast],
  );

  const track = async (key: string, work: () => Promise<void>) => {
    setReplyStates((current) => ({ ...current, [key]: 'loading' }));
    try {
      await work();
      setReplyStates((current) => ({ ...current, [key]: 'done' }));
    } catch (caught) {
      setReplyStates((current) => ({ ...current, [key]: 'error' }));
      toast(errorMessage(caught), 'error');
    }
  };

  const prepare = (key: string, optionId: string) =>
    track(key, async () => {
      if (!caseId) throw new Error('missing conversation');
      setActive(await api.prepareAction(caseId, optionId));
      setPanel('plan');
    });

  const onQuickReply = (reply: QuickReply, key: string) => {
    if (reply.send) return void send(reply.send);
    switch (reply.action) {
      case 'open_plan':
        setPanel(((reply.payload?.tab as PanelTab | undefined) ?? 'plan') as PanelTab);
        return;
      case 'upload_bill':
        setAttachRequest({ kind: 'bill', nonce: Date.now() });
        return;
      case 'upload_policy':
        setAttachRequest({ kind: 'policy', nonce: Date.now() });
        return;
      case 'open_insights':
        navigate('insights', (reply.payload?.tab as string | undefined) ?? null);
        return;
      case 'open_goals':
        navigate('goals');
        return;
      case 'report_transaction':
        setReportOpen(true);
        return;
      case 'new_chat':
        navigate('saathi');
        setQueued(String(reply.payload?.message ?? '') || null);
        return;
      case 'create_goal':
        void track(key, async () => {
          const goal = await api.createGoal(toGoalInput(reply.payload));
          toast(`Goal "${goal.name}" created`, 'success');
        });
        return;
      case 'prepare_option':
        void prepare(key, String(reply.payload?.option_id ?? ''));
        return;
      case 'secure_account':
        void prepare(key, 'secure_account');
        return;
      case 'handoff':
        void track(key, async () => {
          if (!caseId) throw new Error('missing conversation');
          setActive(await api.handoff(caseId));
          void refreshHistory();
          toast('A Saathi specialist will continue with you here', 'success');
        });
        return;
    }
  };

  const upload = async (kind: DocumentKind, file: File, ocr: boolean) => {
    const seq = ++seqRef.current;
    setFailure(null);
    setIndicator('reading');
    try {
      let id = activeRef.current?.case_id;
      if (!id) {
        const created = await api.newConversation(language || undefined);
        id = created.case_id;
        setActive(created);
        navigate('saathi', id, { replace: true });
      }
      await api.uploadDocument(id, kind, file, ocr);
      const record = await api.getCase(id);
      if (seq !== seqRef.current) return;
      setActive(record);
      void refreshHistory();
    } catch (caught) {
      if (seq !== seqRef.current) return;
      setFailure({ message: errorMessage(caught), retry: () => void upload(kind, file, ocr) });
    } finally {
      if (seq === seqRef.current) setIndicator(null);
    }
  };

  const onAttach = (kind: DocumentKind, file: File) => {
    if (file.size > 5 * 1024 * 1024) return toast('That file is larger than 5 MB. Please choose a smaller file.', 'error');
    if (file.type.startsWith('image/')) {
      if (!integrations.openai_available) return toast("Photos can't be read right now. Please upload a PDF or text file.", 'error');
      return setPhoto({ kind, file });
    }
    void upload(kind, file, false);
  };

  const grantVoiceConsent = async () => {
    try {
      const consents = await api.setConsents({ voice: true });
      setVoiceConsent(consents.voice);
      return consents.voice;
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      return false;
    }
  };

  const requestCallBack = async () => {
    setCallingBack(true);
    try {
      const created = await api.newConversation(language || undefined);
      await api.renameConversation(created.case_id, 'Specialist call back');
      const record = await api.handoff(created.case_id, 'Money SOS: please call me back.');
      setActive(record);
      navigate('saathi', record.case_id, { replace: true });
      void refreshHistory();
      toast('A Saathi specialist will call you on your registered number', 'success');
    } catch (caught) {
      toast(errorMessage(caught), 'error');
    } finally {
      setCallingBack(false);
    }
  };

  const messages: ChatMessage[] = active?.messages ?? [];
  const lastAssistantIndex = messages.map((message) => message.role).lastIndexOf('assistant');
  const showPending = pending !== null && messages.length <= pending.base;
  const reportTransaction =
    active?.evidence?.transaction ?? (active?.pending_question?.type === 'confirm_transaction' ? active.pending_question.candidates[0] ?? null : null);
  const canDispute = Boolean(active?.decision?.options.some((option) => option.option_id === 'dispute_and_protect' && option.feasible));
  const hasPlan = Boolean(active?.decision);
  const empty = !active && !caseLoading && !pending && !caseError;
  const voiceAvailable = browserVoiceSupported() || (integrations.sarvam_available && recorderAvailable());

  return (
    <main className="chat-page">
      <div className={`history-wrap ${historyOpen ? 'open' : ''}`}>
        <div className="history-backdrop" onClick={() => setHistoryOpen(false)} />
        <HistoryPanel
          conversations={conversations}
          activeId={active?.case_id ?? null}
          loading={historyLoading}
          error={historyError}
          onRetry={() => void refreshHistory()}
          onNew={() => navigate('saathi', 'new')}
          onSelect={(id) => {
            setHistoryOpen(false);
            navigate('saathi', id);
          }}
          onRenamed={(summary) => {
            setConversations((current) => current.map((item) => (item.case_id === summary.case_id ? summary : item)));
            if (activeRef.current?.case_id === summary.case_id) setActive({ ...activeRef.current, title: summary.title, title_locked: true });
          }}
          onDeleted={(id) => {
            setConversations((current) => current.filter((item) => item.case_id !== id));
            if (activeRef.current?.case_id === id) navigate('saathi', 'new', { replace: true });
          }}
        />
      </div>

      <section className="chat-main">
        <header className="chat-head">
          <button className="icon-btn history-toggle" onClick={() => setHistoryOpen(true)} aria-label="Show chat history">
            <Icon name="menu" />
          </button>
          <div className="chat-title">
            <h1>{active?.title ?? (routeParam === SOS_PARAM ? 'Money SOS' : 'New chat')}</h1>
            {active && active.messages.length > 0 && <small className="muted">{STATUS_LABELS[active.status]}</small>}
          </div>
          {hasPlan && (
            <button className="btn btn-sm" onClick={() => setPanel('plan')}>
              <Icon name="file" size={16} /> View plan
            </button>
          )}
          <button className="icon-btn" onClick={() => navigate('saathi', 'new')} aria-label="New chat" title="New chat">
            <Icon name="plus" />
          </button>
        </header>

        <div className="chat-scroll" ref={scrollRef}>
          {caseLoading ? (
            <Loading label="Opening conversation..." />
          ) : caseError ? (
            <ErrorState message={caseError} onRetry={() => navigate('saathi', 'new')} />
          ) : empty && routeParam === SOS_PARAM ? (
            <SosEmpty
              onSpeak={() => setVoiceRequest(Date.now())}
              onSend={(text) => void send(text, null)}
              onCallMe={() => void requestCallBack()}
              callingBusy={callingBack}
              voiceAvailable={voiceAvailable}
            />
          ) : empty ? (
            <div className="chat-empty">
              <BrandMark size={52} />
              <h2>How can Saathi help you today?</h2>
              <p className="muted">Tell Saathi what happened or what you want to achieve. Saathi helps you figure out what comes next.</p>
              <p className="chat-languages muted">
                <Icon name="globe" size={14} /> Type or speak in English, Hinglish, हिन्दी, বাংলা, தமிழ், తెలుగు, मराठी, ગુજરાતી, ಕನ್ನಡ, മലയാളം, ਪੰਜਾਬੀ or ଓଡ଼ିଆ.
              </p>
              <div className="suggestions">
                {SUGGESTIONS.map((suggestion) => (
                  <button key={suggestion.text} className="suggestion" onClick={() => void send(suggestion.text, null)}>
                    <Icon name={suggestion.icon} size={18} />
                    <span>{suggestion.text}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <ol className="messages">
              {messages.map((message, index) => {
                const isLast = index === lastAssistantIndex && index === messages.length - 1;
                return (
                  <li key={`${message.at}-${index}`} className={`msg msg-${message.role}`}>
                    {message.role === 'assistant' && (
                      <span className="msg-avatar">
                        <BrandMark size={28} />
                      </span>
                    )}
                    <div className="msg-content">
                      <div className="bubble">
                        {message.role === 'assistant' ? <TranslatedBody message={message} /> : <MessageBody text={message.content} />}
                        {message.role === 'user' && message.understood && (
                          <p className="msg-understood">
                            Saathi understood: <em>{message.understood}</em>
                          </p>
                        )}
                      </div>
                      {message.card && active && (
                        <MessageCard
                          card={message.card}
                          record={active}
                          busy={busy}
                          run={run}
                          onOpenPlan={(tab) => setPanel(tab)}
                          onApprove={(optionId) => prepare(`card:${index}:${optionId}`, optionId)}
                          approveState={replyStates[`card:${index}:${active.decision?.recommended_option_id ?? ''}`]}
                        />
                      )}
                      {message.role === 'assistant' && isLast && !pending && message.quick_replies && message.quick_replies.length > 0 && (
                        <div className="quick-replies">
                          {message.quick_replies.map((reply) => {
                            const key = `${index}:${reply.label}`;
                            const state = replyStates[key];
                            return (
                              <button
                                key={key}
                                className={`chip ${state ? `chip-${state}` : ''}`}
                                disabled={state === 'loading' || state === 'done' || indicator !== null}
                                onClick={() => onQuickReply(reply, key)}
                              >
                                {state === 'loading' && <span className="spinner spinner-sm" aria-hidden />}
                                {state === 'done' && <Icon name="check" size={14} />}
                                {state === 'error' && <Icon name="alert" size={14} />}
                                {reply.label}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      {message.role === 'assistant' && integrations.sarvam_available && voiceConsent && (
                        <div className="msg-tools">
                          <ListenButton text={message.content} language={message.language || language} />
                        </div>
                      )}
                    </div>
                  </li>
                );
              })}
              {showPending && (
                <li className="msg msg-user">
                  <div className="msg-content">
                    <div className={`bubble ${failure ? 'bubble-failed' : ''}`}>
                      <MessageBody text={pending!.text} />
                    </div>
                  </div>
                </li>
              )}
              {indicator && (
                <li className="msg msg-assistant">
                  <span className="msg-avatar">
                    <BrandMark size={28} />
                  </span>
                  <div className="msg-content">
                    <div className="bubble typing" role="status">
                      <span className="dots" aria-hidden>
                        <i />
                        <i />
                        <i />
                      </span>
                      {indicator === 'reading' ? 'Reading your document...' : 'Saathi is thinking...'}
                    </div>
                  </div>
                </li>
              )}
              {failure && (
                <li className="msg msg-assistant">
                  <span className="msg-avatar">
                    <BrandMark size={28} />
                  </span>
                  <div className="msg-content">
                    <div className="bubble bubble-error" role="alert">
                      <p>{failure.message}</p>
                      <button className="btn btn-sm" onClick={failure.retry}>
                        Try again
                      </button>
                    </div>
                  </div>
                </li>
              )}
            </ol>
          )}
        </div>

        <Composer
          value={draft}
          onChange={setDraft}
          onSend={(text) => {
            setDraft('');
            void send(text);
          }}
          busy={indicator !== null || caseLoading}
          sarvamAvailable={integrations.sarvam_available}
          voiceConsent={voiceConsent}
          onGrantVoiceConsent={grantVoiceConsent}
          onAttach={onAttach}
          attachRequest={attachRequest}
          voiceRequest={voiceRequest}
          language={language}
          onLanguageChange={setLanguage}
          placeholder={active ? 'Reply to Saathi' : 'Tell Saathi what happened, in any Indian language'}
        />
      </section>

      {panel && active && (
        <div className="drawer-wrap">
          <div className="drawer-backdrop" onClick={() => setPanel(null)} />
          <aside className="drawer" aria-label="Plan details">
            <CasePanel
              caseRecord={active}
              onChange={(record) => {
                setActive(record);
                void refreshHistory();
              }}
              integrations={integrations}
              readOnly={false}
              tab={panel}
              onTabChange={setPanel}
              onClose={() => setPanel(null)}
            />
          </aside>
        </div>
      )}

      {reportOpen && (
        <ReportModal
          transaction={reportTransaction}
          onClose={() => setReportOpen(false)}
          onDispute={canDispute ? () => void prepare('report:dispute', 'dispute_and_protect') : null}
        />
      )}

      {photo && (
        <ConfirmDialog
          title="Read text from this photo?"
          body="Saathi will send this photo to an AI service to extract the text. Only the text is kept, with contact details removed."
          confirmLabel="Allow and upload"
          onCancel={() => setPhoto(null)}
          onConfirm={() => {
            const next = photo;
            setPhoto(null);
            void upload(next.kind, next.file, true);
          }}
        />
      )}
    </main>
  );
}
