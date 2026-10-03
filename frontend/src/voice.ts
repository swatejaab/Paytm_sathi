import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';

export type VoiceState = 'idle' | 'listening' | 'processing' | 'ready' | 'error';
export type VoiceEngine = 'sarvam' | 'browser';

interface RecognitionResultList {
  length: number;
  [index: number]: { isFinal: boolean; 0: { transcript: string } };
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: { resultIndex: number; results: RecognitionResultList }) => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start: () => void;
  stop: () => void;
  abort: () => void;
}
type RecognitionConstructor = new () => Recognition;

function browserRecognition(): RecognitionConstructor | null {
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export const browserVoiceSupported = (): boolean => Boolean(browserRecognition());
const recorderSupported = (): boolean => Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== 'undefined';

const PERMISSION_DENIED = 'Microphone access is blocked. Allow the microphone for this site in your browser settings, or type your message.';
const NO_SPEECH = "I didn't catch that. Please try again, or type your message.";
const UNSUPPORTED = "Voice input isn't available in this browser. You can type your message instead.";

// English recognition handles Hinglish written in Latin script; Hindi returns Devanagari.
const recognitionLanguage = (language: string): string => (language && language !== 'en-IN' ? language : 'en-IN');

export const recorderAvailable = recorderSupported;

interface Options {
  engine: VoiceEngine | null;
  language: string;
  onText: (text: string) => void;
  onPartial?: (text: string) => void;
}

export function useVoiceInput({ engine, language, onText, onPartial }: Options) {
  const [state, setState] = useState<VoiceState>('idle');
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const recognitionRef = useRef<Recognition | null>(null);
  const transcriptRef = useRef('');
  const callbacks = useRef({ onText, onPartial });
  callbacks.current = { onText, onPartial };

  useEffect(
    () => () => {
      recognitionRef.current?.abort();
      if (recorderRef.current?.state === 'recording') recorderRef.current.stop();
    },
    [],
  );

  const fail = (message: string) => {
    setError(message);
    setState('error');
  };

  const startSarvam = async () => {
    if (!recorderSupported()) return fail(UNSUPPORTED);
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return fail(PERMISSION_DENIED);
    }
    const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks: BlobPart[] = [];
    recorder.ondataavailable = (event) => chunks.push(event.data);
    recorder.onstop = async () => {
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
      if (blob.size < 800) return fail(NO_SPEECH);
      setState('processing');
      try {
        const result = await api.transcribe(blob, `voice-note.${blob.type.includes('wav') ? 'wav' : 'webm'}`, language || undefined);
        if (!result.transcript.trim()) return fail(NO_SPEECH);
        callbacks.current.onText(result.transcript.trim());
        setState('ready');
      } catch (caught) {
        fail(caught instanceof ApiError && caught.status < 500 ? caught.message : "I couldn't convert your voice to text. Please try again, or type your message.");
      }
    };
    recorder.start();
    recorderRef.current = recorder;
    setState('listening');
  };

  const startBrowser = () => {
    const Constructor = browserRecognition();
    if (!Constructor) return fail(UNSUPPORTED);
    const recognition = new Constructor();
    recognition.lang = recognitionLanguage(language);
    recognition.continuous = true;
    recognition.interimResults = true;
    transcriptRef.current = '';
    let failed = false;
    recognition.onresult = (event) => {
      let finalText = '';
      let interim = '';
      for (let index = 0; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        if (result.isFinal) finalText += result[0].transcript;
        else interim += result[0].transcript;
      }
      transcriptRef.current = finalText;
      callbacks.current.onPartial?.(`${finalText}${interim}`.trim());
    };
    recognition.onerror = (event) => {
      failed = true;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') fail(PERMISSION_DENIED);
      else if (event.error === 'no-speech' || event.error === 'aborted') fail(NO_SPEECH);
      else if (event.error === 'network') fail('Voice recognition needs an internet connection in this browser. You can type instead.');
      else fail("I couldn't convert your voice to text. Please try again, or type your message.");
    };
    recognition.onend = () => {
      recognitionRef.current = null;
      if (failed) return;
      const text = transcriptRef.current.trim();
      if (!text) return fail(NO_SPEECH);
      callbacks.current.onText(text);
      setState('ready');
    };
    try {
      recognition.start();
    } catch {
      return fail(UNSUPPORTED);
    }
    recognitionRef.current = recognition;
    setState('listening');
  };

  const start = useCallback(
    (override?: VoiceEngine) => {
      setError(null);
      const chosen = override ?? engine;
      if (chosen === 'sarvam') void startSarvam();
      else if (chosen === 'browser') startBrowser();
      else fail(UNSUPPORTED);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [engine, language],
  );

  const stop = useCallback(() => {
    if (recorderRef.current?.state === 'recording') {
      recorderRef.current.stop();
      setState('processing');
    } else if (recognitionRef.current) {
      setState('processing');
      recognitionRef.current.stop();
    }
  }, []);

  const reset = useCallback(() => {
    setError(null);
    setState('idle');
  }, []);

  return { state, error, start, stop, reset };
}
