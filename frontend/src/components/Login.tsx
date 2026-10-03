import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import { HeroArt } from '../mobile/HeroArt';
import type { Session, SessionUser } from '../types';

const DEMO_PASSCODES: Record<string, string> = {
  'demo-customer-01': '2468',
  'demo-customer-02': '1357',
  'support-agent-01': '9999',
};

const DESCRIPTIONS: Record<string, string> = {
  'demo-customer-01': 'Hero journey. Tight savings, so Saathi recommends the exact-gap plan.',
  'demo-customer-02': 'Healthy savings buffer, so Saathi recommends savings over credit.',
  'support-agent-01': 'Specialist queue. Reads Resolution Passports and cannot approve actions.',
};

export function Login({ onLogin, apiOnline }: { onLogin: (session: Session) => void; apiOnline: boolean | null }) {
  const [users, setUsers] = useState<SessionUser[]>([]);
  const [userId, setUserId] = useState('demo-customer-01');
  const [passcode, setPasscode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .demoUsers()
      .then((result) => setUsers(result.users))
      .catch(() => setUsers([]));
  }, [apiOnline]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.login(userId, passcode);
      onLogin({ token: result.access_token, user: result.user, expires_at: Date.now() + result.expires_in * 1000 });
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Sign-in failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <section className="login-hero">
        <HeroArt className="login-art" />
        <p className="eyebrow">Life happened?</p>
        <h1>From money problem to approved resolution.</h1>
        <p className="lead">
          Tell Saathi once. See the evidence. Choose the next step. Saathi compares claims, savings, exact-gap credit, and
          human help on cost, risk, time, and effort. Commission is never an input.
        </p>
        <div className="trust-band">
          <div>
            AI understands<span>Classify, retrieve, extract</span>
          </div>
          <div>
            Rules calculate<span>Coverage, gap, affordability</span>
          </div>
          <div>
            You approve<span>Exact action and amount</span>
          </div>
          <div>
            Partner decides<span>Claim and credit outcomes</span>
          </div>
        </div>
      </section>
      <form className="card login-card" onSubmit={submit}>
        <h2>Sign in to Saathi</h2>
        <p className="muted small">The demo signs you in with a short-lived JWT. Every case is checked for ownership.</p>
        <div className="user-choices">
          {(users.length ? users : Object.keys(DEMO_PASSCODES).map((id) => ({ user_id: id, display_name: id, role: 'customer' as const }))).map(
            (user) => (
              <label key={user.user_id} className={`user-choice ${userId === user.user_id ? 'selected' : ''}`}>
                <input
                  type="radio"
                  name="user"
                  value={user.user_id}
                  checked={userId === user.user_id}
                  onChange={() => {
                    setUserId(user.user_id);
                    setPasscode('');
                  }}
                />
                <span>
                  <strong>{user.display_name}</strong>
                  <small>
                    {user.role} / {DESCRIPTIONS[user.user_id] ?? user.user_id}
                  </small>
                </span>
              </label>
            ),
          )}
        </div>
        <label className="field">
          <span>Demo passcode</span>
          <input
            type="password"
            inputMode="numeric"
            autoComplete="off"
            value={passcode}
            onChange={(event) => setPasscode(event.target.value)}
            placeholder={`PIN (hint: ${DEMO_PASSCODES[userId] ?? ''})`}
          />
        </label>
        {error && <p className="alert alert-error">{error}</p>}
        <button className="btn btn-primary btn-block" disabled={busy || !passcode}>
          {busy ? 'Signing in...' : 'Sign in'}
        </button>
        {apiOnline === false && <p className="alert alert-warn">Saathi is not reachable right now. Please try again shortly.</p>}
      </form>
    </main>
  );
}
