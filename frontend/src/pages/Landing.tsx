import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api';
import { Icon, type IconName } from '../components/Icon';
import { SOS_PARAM, SosStrip, TAGLINE } from '../components/MoneySos';
import type { Page } from '../router';
import type { Session, SessionUser } from '../types';

// Passcodes for the bundled sample accounts; real sign-in would use Paytm authentication.
const SAMPLE_PASSCODES: Record<string, string> = {
  'demo-customer-01': '2468',
  'demo-customer-02': '1357',
  'demo-customer-03': '8642',
  'support-agent-01': '9999',
};

export const CTAS: { label: string; page: Page; icon: IconName; primary?: boolean }[] = [
  { label: 'Ask Saathi', page: 'saathi', icon: 'chat', primary: true },
  { label: 'Check Financial Health', page: 'insights', icon: 'gauge' },
  { label: 'View Goals', page: 'goals', icon: 'target' },
  { label: 'Explore Insights', page: 'insights', icon: 'insights' },
];

const FEATURES: { icon: IconName; title: string; body: string }[] = [
  { icon: 'sparkle', title: 'Understands your situation', body: 'Describe what happened in English, Hindi, or Hinglish, by text or voice. Saathi asks only for what it still needs.' },
  { icon: 'rupee', title: 'Explains every number', body: 'Every amount comes from what you shared, your documents, or your account, with the calculation shown.' },
  { icon: 'shield', title: 'You stay in control', body: 'Saathi prepares the next steps. Nothing happens to your money until you review and approve it.' },
];

export function Landing({ onLogin }: { onLogin: (session: Session, next: Page, param?: string | null) => void }) {
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [usersError, setUsersError] = useState(false);
  const [userId, setUserId] = useState('demo-customer-01');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [next, setNext] = useState<{ page: Page; param: string | null }>({ page: 'home', param: null });
  const passcodeRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLFormElement>(null);

  const loadUsers = () => {
    setUsersError(false);
    api
      .accounts()
      .then((result) => setUsers(result.users))
      .catch(() => setUsersError(true));
  };
  useEffect(loadUsers, []);

  const startWith = (page: Page, param: string | null = null) => {
    setNext({ page, param });
    cardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    window.setTimeout(() => passcodeRef.current?.focus(), 350);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(userId, passcode);
      const session = { token: result.access_token, user: result.user, expires_at: Date.now() + result.expires_in * 1000 };
      onLogin(session, next.page, next.param);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="landing">
      <section className="hero">
        <div className="hero-copy">
          <span className="pill">
            <Icon name="sparkle" size={16} /> AI companion by Paytm
          </span>
          <h1>
            Meet <span className="accent">Paytm Saathi</span>
          </h1>
          <p className="lead tagline">{TAGLINE}</p>
          <p className="lead">Your AI companion for everyday financial decisions and emergencies.</p>
          <div className="cta-row">
            {CTAS.map((cta) => (
              <button key={cta.label} className={`btn ${cta.primary ? 'btn-primary' : 'btn-outline'} btn-lg`} onClick={() => startWith(cta.page)}>
                <Icon name={cta.icon} size={18} /> {cta.label}
              </button>
            ))}
          </div>
          <SosStrip onOpen={() => startWith('saathi', SOS_PARAM)} />
          <div className="feature-row">
            {FEATURES.map((feature) => (
              <div key={feature.title} className="feature">
                <span className="feature-icon">
                  <Icon name={feature.icon} />
                </span>
                <div>
                  <strong>{feature.title}</strong>
                  <p>{feature.body}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <form className="card signin-card" onSubmit={submit} ref={cardRef} aria-label="Sign in">
          <h2>Sign in</h2>
          <p className="muted small">Choose your account and enter your passcode.</p>
          {usersError && (
            <div className="alert alert-warn small">
              Saathi can't be reached right now.{' '}
              <button type="button" className="link" onClick={loadUsers}>
                Try again
              </button>
            </div>
          )}
          <div className="account-list" role="radiogroup" aria-label="Account">
            {users.map((user) => (
              <label key={user.user_id} className={`account ${userId === user.user_id ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="account"
                  value={user.user_id}
                  checked={userId === user.user_id}
                  onChange={() => {
                    setUserId(user.user_id);
                    setPasscode('');
                    setError(null);
                  }}
                />
                <span className="avatar">{user.display_name.slice(0, 1)}</span>
                <span>
                  <strong>{user.display_name}</strong>
                  <small>{user.role === 'support' ? 'Saathi specialist' : 'Customer'}</small>
                </span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>Passcode</span>
            <input
              ref={passcodeRef}
              className="input"
              type="password"
              inputMode="numeric"
              autoComplete="current-password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              placeholder="4-digit passcode"
            />
          </label>
          {SAMPLE_PASSCODES[userId] && (
            <button type="button" className="link small" onClick={() => setPasscode(SAMPLE_PASSCODES[userId]!)}>
              Use sample passcode
            </button>
          )}
          {error && <p className="alert alert-error">{error}</p>}
          <button className="btn btn-primary btn-block btn-lg" disabled={busy || !passcode}>
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
          <p className="muted tiny">Saathi checks your consent before reading any records and asks before any financial action.</p>
        </form>
      </section>
    </main>
  );
}
