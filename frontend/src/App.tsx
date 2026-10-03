import { useCallback, useEffect, useState } from 'react';
import { api, loadSession, saveSession, setUnauthorizedHandler } from './api';
import { CustomerWorkspace } from './components/CustomerWorkspace';
import { HomeView } from './components/HomeView';
import { MobileApp } from './mobile/MobileApp';
import { readViewMode, saveViewMode, ViewToggle, type ViewMode } from './mobile/ViewToggle';
import { ThemeToggle, useTheme } from './theme';
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
  const [view, setViewState] = useState<ViewMode>(readViewMode);
  const [theme, toggleTheme] = useTheme();
  const setView = (mode: ViewMode) => {
    saveViewMode(mode);
    setViewState(mode);
  };
  const [seed, setSeed] = useState<{ text: string; nonce: number; hint?: boolean } | null>(null);

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

  // App view: a mobile banking experience (phone frame on wide screens). Specialists keep the desk layout.
  if (view === 'app' && session?.user.role !== 'support') {
    return (
      <div className="phone-stage">
        <div className="stage-bar">
          <span className="stage-brand">
            Paytm <b>Saathi</b>
          </span>
          <span className="stage-actions">
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <ViewToggle mode={view} onChange={setView} />
          </span>
        </div>
        <div className="phone-frame">
          <div className="phone-screen">
            <MobileApp session={session} integrations={integrations} onLogin={login} onLogout={logout} onWebView={() => setView('web')} theme={theme} onToggleTheme={toggleTheme} />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <TopBar
        session={session}
        apiOnline={apiOnline}
        integrations={integrations}
        onLogout={logout}
        viewToggle={
          <>
            <ThemeToggle theme={theme} onToggle={toggleTheme} />
            <ViewToggle mode={view} onChange={setView} />
          </>
        }
      />
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
              onTopic={(text) => {
                setSeed({ text, nonce: Date.now(), hint: true });
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
