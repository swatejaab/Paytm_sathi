import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';

interface Props {
  available: boolean;
  disabled: boolean;
  onTranscript: (text: string) => void;
}

export function VoiceNote({ available, disabled, onTranscript }: Props) {
  const [recording, setRecording] = useState(false);
  const [audio, setAudio] = useState<Blob | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const start = async () => {
    setMessage(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks: BlobPart[] = [];
      recorder.ondataavailable = (event) => chunks.push(event.data);
      recorder.onstop = () => {
        stream.getTracks().forEach((track) => track.stop());
        const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
        setAudio(blob);
        setAudioUrl(URL.createObjectURL(blob));
      };
      recorder.start();
      recorderRef.current = recorder;
      setRecording(true);
    } catch {
      setMessage('Microphone access was blocked. You can type your message instead.');
    }
  };

  const stop = () => {
    recorderRef.current?.stop();
    setRecording(false);
  };

  const transcribe = async () => {
    if (!audio) return;
    setBusy(true);
    setMessage(null);
    try {
      const extension = audio.type.includes('wav') ? 'wav' : 'webm';
      const result = await api.transcribe(audio, `voice-note.${extension}`);
      onTranscript(result.transcript);
      setMessage(`Transcript added to the message box${result.language_code ? ` (${result.language_code})` : ''}. Review it before starting the case.`);
    } catch (caught) {
      setMessage(caught instanceof ApiError ? caught.message : 'Voice transcription failed. Try again or type your message.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="voice-note">
      <summary>🎙️ Use a voice note (Hindi / Hinglish / English)</summary>
      {!available ? (
        <p className="muted small">
          Sarvam is disabled until a rotated API key is configured and <code>SARVAM_ENABLED=true</code> is set. Typed chat
          completes the whole journey.
        </p>
      ) : (
        <div className="voice-body">
          <div className="row">
            {!recording ? (
              <button className="btn" onClick={start} disabled={disabled || busy}>
                ● Record
              </button>
            ) : (
              <button className="btn btn-danger" onClick={stop}>
                ■ Stop
              </button>
            )}
            {audioUrl && <audio controls src={audioUrl} />}
          </div>
          <label className="checkbox">
            <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />I agree to send this
            audio to Sarvam for transcription.
          </label>
          <button className="btn btn-primary" disabled={!audio || !consent || busy} onClick={transcribe}>
            {busy ? 'Transcribing...' : 'Transcribe with Sarvam'}
          </button>
        </div>
      )}
      {message && <p className="muted small">{message}</p>}
    </details>
  );
}
