import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { readPref, writePref } from '../../format';
import { browserVoiceSupported, recorderAvailable, useVoiceInput, type VoiceEngine } from '../../voice';
import { Icon } from '../Icon';

export type DocumentKind = 'bill' | 'policy';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSend: (text: string) => void;
  busy: boolean;
  sarvamAvailable: boolean;
  voiceConsent: boolean;
  onGrantVoiceConsent: () => Promise<boolean>;
  onAttach: (kind: DocumentKind, file: File) => void;
  attachRequest: { kind: DocumentKind; nonce: number } | null;
  voiceRequest?: number | null;
  placeholder?: string;
}

const VOICE_LANG_KEY = 'saathi.voiceLanguage';
const VOICE_LANGUAGES = [
  { code: 'en-IN', label: 'English / Hinglish' },
  { code: 'hi-IN', label: 'हिन्दी' },
];

const STATUS_TEXT = {
  listening: 'Listening... tap stop when you are done.',
  processing: 'Converting your voice to text...',
  ready: 'Check the text below, edit it if needed, then send.',
};

export function Composer({
  value,
  onChange,
  onSend,
  busy,
  sarvamAvailable,
  voiceConsent,
  onGrantVoiceConsent,
  onAttach,
  attachRequest,
  voiceRequest,
  placeholder,
}: Props) {
  const textRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const attachRef = useRef<HTMLDivElement>(null);
  const [kind, setKind] = useState<DocumentKind>('bill');
  const [attachOpen, setAttachOpen] = useState(false);
  const [consentPrompt, setConsentPrompt] = useState(false);
  const [voiceLanguage, setVoiceLanguage] = useState(() => readPref(VOICE_LANG_KEY, readPref('saathi.language', '') === 'hi-IN' ? 'hi-IN' : 'en-IN'));
  const baseRef = useRef('');

  const browserVoice = browserVoiceSupported();
  const sarvamReady = sarvamAvailable && recorderAvailable();
  const engine: VoiceEngine | null = sarvamReady && voiceConsent ? 'sarvam' : browserVoice ? 'browser' : null;
  const voiceUnavailable = !sarvamReady && !browserVoice;

  const join = (text: string) => [baseRef.current.trim(), text].filter(Boolean).join(' ');
  const voice = useVoiceInput({
    engine,
    language: voiceLanguage,
    onText: (text) => onChange(join(text)),
    onPartial: (text) => onChange(join(text)),
  });

  useEffect(() => {
    const element = textRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 180)}px`;
  }, [value]);

  useEffect(() => {
    if (!attachRequest) return;
    setKind(attachRequest.kind);
    fileRef.current?.click();
  }, [attachRequest]);

  useEffect(() => {
    if (!attachOpen) return;
    const close = (event: MouseEvent) => !attachRef.current?.contains(event.target as Node) && setAttachOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [attachOpen]);

  const listening = voice.state === 'listening';
  const processing = voice.state === 'processing';

  const send = () => {
    const text = value.trim();
    if (!text || busy || listening || processing) return;
    onSend(text);
    voice.reset();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      send();
    }
  };

  const startVoice = (override?: VoiceEngine) => {
    baseRef.current = value;
    voice.start(override);
  };

  const onMic = () => {
    if (listening) return voice.stop();
    if (sarvamReady && !voiceConsent) return setConsentPrompt(true);
    startVoice();
  };

  useEffect(() => {
    if (voiceRequest && !listening && !processing && !voiceUnavailable) onMic();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [voiceRequest]);

  const allowSarvam = async () => {
    setConsentPrompt(false);
    if (await onGrantVoiceConsent()) startVoice('sarvam');
  };

  const pickFile = (next: DocumentKind) => {
    setKind(next);
    setAttachOpen(false);
    fileRef.current?.click();
  };

  const status = voice.state === 'error' ? voice.error : voice.state === 'idle' ? null : STATUS_TEXT[voice.state];

  return (
    <div className="composer-wrap">
      {status && (
        <div className={`voice-status voice-${voice.state}`} role="status" aria-live="polite">
          {listening && <span className="pulse-dot" aria-hidden />}
          <span>{status}</span>
          {(voice.state === 'error' || voice.state === 'ready') && (
            <button className="icon-btn icon-btn-sm" onClick={voice.reset} aria-label="Dismiss">
              <Icon name="close" size={14} />
            </button>
          )}
        </div>
      )}
      {consentPrompt && (
        <div className="voice-consent" role="dialog" aria-label="Voice permission">
          <p>
            <strong>Use voice input?</strong> Your recording is sent to Sarvam AI only to convert it to text. The audio isn't stored.
          </p>
          <div className="row gap-sm wrap">
            <button className="btn btn-sm btn-primary" onClick={() => void allowSarvam()}>
              Allow
            </button>
            {browserVoice && (
              <button
                className="btn btn-sm"
                onClick={() => {
                  setConsentPrompt(false);
                  startVoice('browser');
                }}
              >
                Use my browser instead
              </button>
            )}
            <button className="btn btn-sm btn-ghost" onClick={() => setConsentPrompt(false)}>
              Not now
            </button>
          </div>
        </div>
      )}
      <div className={`composer ${listening ? 'is-listening' : ''}`}>
        <div className="attach" ref={attachRef}>
          <button className="icon-btn" onClick={() => setAttachOpen(!attachOpen)} aria-label="Attach a document" aria-haspopup="menu" aria-expanded={attachOpen} disabled={busy}>
            <Icon name="clip" />
          </button>
          {attachOpen && (
            <div className="menu menu-up" role="menu">
              <button role="menuitem" onClick={() => pickFile('bill')}>
                <Icon name="file" size={18} /> Upload a bill
              </button>
              <button role="menuitem" onClick={() => pickFile('policy')}>
                <Icon name="shield" size={18} /> Upload an insurance policy
              </button>
            </div>
          )}
          <input
            ref={fileRef}
            type="file"
            hidden
            accept=".pdf,.txt,.json,.jpg,.jpeg,.png,.webp"
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (file) onAttach(kind, file);
            }}
          />
        </div>
        <textarea
          ref={textRef}
          rows={1}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={onKeyDown}
          placeholder={listening ? 'Listening...' : placeholder ?? 'Message Saathi'}
          maxLength={2000}
          aria-label="Message Saathi"
          readOnly={listening || processing}
        />
        <select
          className="voice-lang"
          value={voiceLanguage}
          onChange={(event) => {
            setVoiceLanguage(event.target.value);
            writePref(VOICE_LANG_KEY, event.target.value);
          }}
          aria-label="Voice language"
          title="Voice language"
          disabled={listening || processing}
        >
          {VOICE_LANGUAGES.map((language) => (
            <option key={language.code} value={language.code}>
              {language.label}
            </option>
          ))}
        </select>
        <button
          className={`icon-btn mic ${listening ? 'mic-on' : ''}`}
          onClick={onMic}
          disabled={processing || voiceUnavailable}
          aria-label={listening ? 'Stop recording' : 'Speak your message'}
          title={voiceUnavailable ? "Voice input isn't available in this browser" : listening ? 'Stop' : 'Speak'}
        >
          <Icon name={listening ? 'stop' : 'mic'} />
        </button>
        <button className="send-btn" onClick={send} disabled={!value.trim() || busy || listening || processing} aria-label="Send message">
          <Icon name="send" size={18} />
        </button>
      </div>
      <p className="composer-hint">Saathi can make mistakes. Check important details, and nothing happens to your money without your approval.</p>
    </div>
  );
}
