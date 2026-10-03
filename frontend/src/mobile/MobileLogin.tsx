import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import type { Session, SessionUser } from '../types';
import { HeroArt } from './HeroArt';
import { Icon } from './Icon';

const DEMO_PINS: Record<string, string> = {
  'demo-customer-01': '2468',
  'demo-customer-02': '1357',
  'support-agent-01': '9999',
};

const TAGLINES: Record<string, string> = {
  'demo-customer-01': 'Savings account ••4821 · Pune',
  'demo-customer-02': 'Savings account ••7305 · Bengaluru',
  'support-agent-01': 'Saathi support team',
};

export const initials = (name: string) =>
  name
    .replace(/\(.*\)/, '')
    .trim()
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join('')
    .toUpperCase();

export function MobileLogin({ onLogin }: { onLogin: (session: Session) => void }) {
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [chosen, setChosen] = useState<SessionUser | null>(null);
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .demoUsers()
      .then((result) => setUsers(result.users))
      .catch(() => setError('Saathi is not reachable right now. Please try again.'));
  }, []);

  useEffect(() => {
    if (pin.length !== 4 || !chosen) return;
    setBusy(true);
    api
      .login(chosen.user_id, pin)
      .then((result) => onLogin({ token: result.access_token, user: result.user, expires_at: Date.now() + result.expires_in * 1000 }))
      .catch((caught) => {
        setError(caught instanceof ApiError ? caught.message : 'Sign-in failed.');
        setPin('');
      })
      .finally(() => setBusy(false));
  }, [pin, chosen, onLogin]);

  const press = (key: string) => {
    setError(null);
    if (key === 'del') setPin((current) => current.slice(0, -1));
    else if (pin.length < 4) setPin((current) => current + key);
  };

  return (
    <div className="m-login">
      <div className="m-login-hero">
        <div className="m-brand-row">
          <span className="m-wordmark">
            Paytm <b>Saathi</b>
          </span>
        </div>
        <HeroArt />
        <h1>Your money companion</h1>
        <p>Claims, loans, payments and protection, sorted in one chat.</p>
      </div>

      {!chosen ? (
        <div className="m-login-body">
          <h2>Who's signing in?</h2>
          <div className="m-profiles">
            {users.map((user) => (
              <button key={user.user_id} className="m-profile" onClick={() => setChosen(user)}>
                <span className={`m-avatar ${user.role === 'support' ? 'support' : ''}`}>{initials(user.display_name)}</span>
                <span className="m-profile-text">
                  <strong>{user.display_name.replace(' (demo)', '')}</strong>
                  <small>{TAGLINES[user.user_id] ?? user.role}</small>
                </span>
                <Icon name="next" size={18} />
              </button>
            ))}
          </div>
          {error && <p className="m-error">{error}</p>}
          <p className="m-fineprint">
            <Icon name="lock" size={14} /> Secured with your PIN
          </p>
        </div>
      ) : (
        <div className="m-login-body m-pin">
          <button className="m-back" onClick={() => { setChosen(null); setPin(''); setError(null); }} aria-label="Back">
            <Icon name="back" />
          </button>
          <span className="m-avatar large">{initials(chosen.display_name)}</span>
          <h2>Hi, {chosen.display_name.split(' ')[0]}</h2>
          <p className="m-muted">Enter your 4-digit PIN</p>
          <div className={`m-dots ${error ? 'shake' : ''}`} aria-label={`${pin.length} of 4 digits entered`}>
            {[0, 1, 2, 3].map((index) => (
              <span key={index} className={index < pin.length ? 'filled' : ''} />
            ))}
          </div>
          {error ? <p className="m-error">{error}</p> : <p className="m-hint">Hint: {DEMO_PINS[chosen.user_id]}</p>}
          <div className="m-keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'del'].map((key, index) =>
              key ? (
                <button key={key} disabled={busy} onClick={() => press(key)} aria-label={key === 'del' ? 'Delete' : key}>
                  {key === 'del' ? <Icon name="backspace" /> : key}
                </button>
              ) : (
                <span key={`gap-${index}`} />
              ),
            )}
          </div>
        </div>
      )}
    </div>
  );
}
