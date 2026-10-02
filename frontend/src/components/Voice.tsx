import { useRef, useState } from 'react';
import { api, ApiError } from '../api';

interface MicProps {
  available: boolean;
  consent: boolean;
  language: string;
  disabled: boolean;
  onTranscript: (text: string, languageCode: string | null) => void;
  onError: (message: string) => void;
}

// Press to record, press again to stop; the clip goes to Sarvam only when voice consent is ticked.
export function MicButton({ available, consent, language, disabled, onTranscript, onError }: MicProps) {
  const [state, setState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const recorderRef = useRef<MediaRecorder | null>(null);

  const start = async () => {
    if (!consent) {
      onError('Tick "Allow voice processing by Sarvam" to use the mic.');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        setState('transcribing');
        try {
          const result = await api.transcribe(blob, `voice-note.${blob.type.includes('wav') ? 'wav' : 'webm'}`, language || undefined);
          onTranscript(result.transcript, result.language_code);
        } catch (caught) {
          onError(caught instanceof ApiError ? caught.message : 'Voice transcription failed. Try again or type your message.');
        } finally {
          setState('idle');
        }
      };
      recorder.start();
      recorderRef.current = recorder;
      setState('recording');
    } catch {
      onError('Microphone access was blocked. You can type your message instead.');
    }
  };

  const stop = () => recorderRef.current?.stop();

  if (!available) {
    return (
      <button className="btn mic-btn" disabled title="Add SARVAM_API_KEY and SARVAM_ENABLED=true to .env to enable voice">
        🎙️
      </button>
    );
  }
  return (
    <button
      className={`btn mic-btn ${state === 'recording' ? 'mic-recording' : ''}`}
      disabled={disabled || state === 'transcribing'}
      onClick={state === 'recording' ? stop : start}
      title={state === 'recording' ? 'Stop and transcribe' : 'Speak your message'}
      aria-label={state === 'recording' ? 'Stop recording' : 'Record a voice message'}
    >
      {state === 'recording' ? '■' : state === 'transcribing' ? '…' : '🎙️'}
    </button>
  );
}

let currentAudio: HTMLAudioElement | null = null;

export function SpeakButton({ text, language }: { text: string; language: string }) {
  const [busy, setBusy] = useState(false);
  const play = async () => {
    setBusy(true);
    try {
      const result = await api.speak(text, language);
      currentAudio?.pause();
      currentAudio = new Audio(`data:${result.mime_type};base64,${result.audio_base64}`);
      await currentAudio.play();
    } catch {
      // Listening is optional; the text stays on screen.
    } finally {
      setBusy(false);
    }
  };
  return (
    <button className="link speak-btn" onClick={play} disabled={busy} title="Listen (Sarvam voice)" aria-label="Listen to this message">
      {busy ? '…' : '🔊'}
    </button>
  );
}
