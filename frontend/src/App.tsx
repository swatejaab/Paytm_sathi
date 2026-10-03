import { useCallback, useEffect, useState } from 'react';
import { api, loadSession, saveSession, setUnauthorizedHandler } from './api';
import { AppHeader, BottomNav } from './components/AppHeader';
import { SosButton } from './components/MoneySos';
import { SupportQueue } from './components/SupportQueue';
import { ErrorBoundary } from './components/ui';
import { Goals } from './pages/Goals';
import { Home } from './pages/Home';
import { Insights } from './pages/Insights';
import { Landing } from './pages/Landing';
import { More } from './pages/More';
import { Saathi } from './pages/Saathi';
import { navigate, useRoute, type Page } from './router';
import { useTheme } from './theme';
import { ToastProvider } from './toast';
import type { IntegrationStatus, Session } from './types';
import type { ViewMode } from './viewMode';

const NO_INTEGRATIONS: IntegrationStatus = {
  openai_available: false,
  sarvam_available: false,
  n8n_configured: false,
  partner_channel: 'local_mock',
  knowledge_backend: 'local_index',
  lender_adapter: 'local',
};

interface Props {
  viewMode?: ViewMode;
  onViewMode?: (mode: ViewMode) => void;
}

export default function App({ viewMode, onViewMode }: Props) {
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const [theme, setTheme, toggleTheme] = useTheme();
  const [integrations, setIntegrations] = useState<IntegrationStatus>(NO_INTEGRATIONS);
  const [offline, setOffline] = useState(false);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);
  const route = useRoute();

  const logout = useCallback(() => {
    saveSession(null);
    setSession(null);
    navigate('home', null, { replace: true });
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(logout);
    return () => setUnauthorizedHandler(null);
  }, [logout]);

  useEffect(() => {
    let cancelled = false;
    const probe = async () => {
      try {
        const status = await api.integrations();
        if (cancelled) return;
        setIntegrations(status);
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      }
    };
    void probe();
    const timer = window.setInterval(probe, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    window.scrollTo(0, 0);
  }, [route.page]);

  const login = (next: Session, page: Page, param: string | null = null) => {
    saveSession(next);
    setSession(next);
    if (next.user.role === 'support') navigate('home', null, { replace: true });
    else navigate(page, param, { replace: true });
  };

  // Starting a chat from anywhere sends the exact text through the normal chat pipeline in a new conversation.
  const ask = useCallback((text: string) => {
    setSeed({ text, nonce: Date.now() });
    navigate('saathi');
  }, []);

  const user = session?.user ?? null;
  const customer = user?.role === 'customer';

  let content;
  if (!user) content = <Landing onLogin={login} />;
  else if (user.role === 'support') content = <SupportQueue />;
  else if (route.page === 'saathi')
    content = <Saathi key="saathi" integrations={integrations} routeParam={route.param} seed={seed} onSeedUsed={() => setSeed(null)} />;
  else if (route.page === 'insights') content = <Insights onAsk={ask} />;
  else if (route.page === 'goals') content = <Goals onAsk={ask} />;
  else if (route.page === 'more')
    content = <More section={route.param} user={user} integrations={integrations} theme={theme} onTheme={setTheme} onAsk={ask} onLogout={logout} />;
  else content = <Home name={user.display_name} onAsk={ask} />;

  return (
    <ToastProvider>
      <div className={`app ${customer ? 'with-bottom-nav' : ''} page-${user ? route.page : 'landing'}`}>
        <div className="app-bg" aria-hidden />
        <AppHeader user={user} page={route.page} theme={theme} onToggleTheme={toggleTheme} onLogout={logout} viewMode={viewMode} onViewMode={onViewMode} />
        {offline && <div className="offline-banner">Saathi can't be reached right now. Check your connection; we'll keep trying.</div>}
        <ErrorBoundary key={`${route.page}-${user?.user_id ?? 'guest'}`}>{content}</ErrorBoundary>
        {customer && route.page !== 'saathi' && <SosButton className="sos-fab" />}
        {customer && <BottomNav page={route.page} />}
      </div>
    </ToastProvider>
  );
}
