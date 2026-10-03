import { useCallback, useEffect, useState } from 'react';
import { api, loadSession, saveSession, setUnauthorizedHandler } from './api';
import { CustomerWorkspace } from './components/CustomerWorkspace';
import { HomeView } from './components/HomeView';
import { Login } from './components/Login';
import { SupportQueue } from './components/SupportQueue';
import { TopBar } from './components/TopBar';
import type { IntegrationStatus, Session } from './types';

const OFFLINE: IntegrationStatus = {
  openai_available: false,
  sarvam_available: false,
  n8n_configured: false,
  partner_channel: 'local_mock',
  knowledge_backend: 'local_index',
  lender_adapter: 'synthetic_fixture',
};

export default function App() {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [apiOnline, setApiOnline] = useState<boolean | null>(null);
  const [integrations, setIntegrations] = useState<IntegrationStatus>(OFFLINE);
  const [tab, setTab] = useState<'home' | 'saathi'>('home');
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  const logout = useCallback(() => {
    saveSession(null);
    setSession(null);
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        await api.health();
        const status = await api.integrations();
        if (!cancelled) {
          setApiOnline(true);
          setIntegrations(status);
        }
      } catch {
        if (!cancelled) setApiOnline(false);
      }
    };
    void probe();
    const timer = window.setInterval(probe, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  const login = (next: Session) => {
    saveSession(next);
    setSession(next);
  };

  return (
    <div className="app">
      <TopBar session={session} apiOnline={apiOnline} integrations={integrations} onLogout={logout} />
      <div className="demo-banner">
        Synthetic demo data only. Claim, credit, and payment outcomes are simulated; partners make the real decisions.
      </div>
      {!session ? (
        <Login onLogin={login} apiOnline={apiOnline} />
      ) : session.user.role === 'support' ? (
        <SupportQueue />
      ) : (
        <>
          <nav className="app-tabs" aria-label="Main">
            <button className={tab === 'home' ? 'active' : ''} onClick={() => setTab('home')}>
              🏠 Home
            </button>
            <button className={tab === 'saathi' ? 'active' : ''} onClick={() => setTab('saathi')}>
              💬 Saathi
            </button>
          </nav>
          {/* Both stay mounted so an open case survives switching tabs. */}
          <div hidden={tab !== 'home'}>
            <HomeView
              displayName={session.user.display_name}
              onAsk={(text) => {
                setSeed({ text, nonce: Date.now() });
                setTab('saathi');
              }}
            />
          </div>
          <div hidden={tab !== 'saathi'}>
            <CustomerWorkspace integrations={integrations} seed={seed} onSeedUsed={() => setSeed(null)} />
          </div>
        </>
      )}
    </div>
  );
}
