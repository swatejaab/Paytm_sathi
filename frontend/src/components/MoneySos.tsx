import { routeHref } from '../router';
import { Icon, type IconName } from './Icon';

export const SOS_PARAM = 'sos';
export const TAGLINE = "Life happened? Tell Saathi. We'll handle what's next.";

export const SOS_PROMPTS: { icon: IconName; label: string; text: string }[] = [
  { icon: 'hospital', label: 'Hospital deposit', text: 'Papa ICU mein hai, ₹80,000 deposit maang rahe hain. Kya karun?' },
  { icon: 'alert', label: "Payment I don't recognise", text: "I don't recognise a UPI payment of ₹8,500." },
  { icon: 'wallet', label: 'Refund not received', text: 'INR 2,450 ka UPI payment failed ho gaya, paise kat gaye par refund nahi aaya.' },
  { icon: 'calendar', label: 'EMI before salary', text: 'Mera EMI Friday ko hai lekin salary Monday ko aayegi.' },
];

export function SosButton({ className = '', label = 'Money SOS' }: { className?: string; label?: string }) {
  return (
    <a className={`sos-btn ${className}`} href={routeHref('saathi', SOS_PARAM)} aria-label="Money SOS: get help with a money emergency">
      <Icon name="sos" size={18} />
      <span>{label}</span>
    </a>
  );
}

export function SosStrip({ onOpen }: { onOpen?: () => void }) {
  return (
    <div className="sos-strip">
      {onOpen ? (
        <button type="button" className="sos-btn sos-btn-lg" onClick={onOpen}>
          <Icon name="sos" size={20} />
          <span>Money SOS</span>
        </button>
      ) : (
        <SosButton className="sos-btn-lg" />
      )}
      <p>
        <strong>One button for any money emergency.</strong> Tell Saathi what happened in any language, by voice or text. You get one plan in under 2
        minutes, or a specialist calls you.
      </p>
    </div>
  );
}

interface EmptyProps {
  onSpeak: () => void;
  onSend: (text: string) => void;
  onCallMe: () => void;
  callingBusy: boolean;
  voiceAvailable: boolean;
}

export function SosEmpty({ onSpeak, onSend, onCallMe, callingBusy, voiceAvailable }: EmptyProps) {
  return (
    <div className="chat-empty sos-empty">
      <span className="sos-badge" aria-hidden>
        <Icon name="sos" size={30} />
      </span>
      <p className="eyebrow">Money SOS</p>
      <h2>Saathi, madad karo</h2>
      <p className="muted">
        One tap, one story in any language. One plan in under 2 minutes, or a specialist calls you. Saathi checks your policy, bills and balance only
        with your permission.
      </p>
      <button type="button" className="sos-mic" onClick={onSpeak} disabled={!voiceAvailable} aria-label="Tap and tell Saathi what happened">
        <Icon name="mic" size={34} />
      </button>
      <small className="muted">{voiceAvailable ? 'Tap and speak, or type below' : 'Type what happened below'}</small>
      <div className="suggestions">
        {SOS_PROMPTS.map((prompt) => (
          <button key={prompt.label} className="suggestion" onClick={() => onSend(prompt.text)}>
            <Icon name={prompt.icon} size={18} />
            <span>
              <strong>{prompt.label}</strong>
              <small className="muted">{prompt.text}</small>
            </span>
          </button>
        ))}
      </div>
      <button type="button" className="btn btn-outline" onClick={onCallMe} disabled={callingBusy}>
        <Icon name="headset" size={18} /> {callingBusy ? 'Requesting a call...' : 'Ask a specialist to call me'}
      </button>
    </div>
  );
}
