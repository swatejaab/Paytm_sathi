import { useCallback, useState } from 'react';
import { api } from '../api';
import type { CaseRecord, IntegrationStatus, Session } from '../types';
import { Icon, type IconName } from './Icon';
import { MobileCase } from './MobileCase';
import { MobileHome } from './MobileHome';
import { MobileLogin } from './MobileLogin';
import { MobileSaathi } from './MobileSaathi';
import { MobileActivity, MobileInsights, MobileProfile } from './MobileScreens';

type Tab = 'home' | 'saathi' | 'insights' | 'activity' | 'profile';

const NAV: { id: Tab; label: string; icon: IconName }[] = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'insights', label: 'Insights', icon: 'insights' },
  { id: 'saathi', label: 'Saathi', icon: 'sparkle' },
  { id: 'activity', label: 'Activity', icon: 'activity' },
  { id: 'profile', label: 'Profile', icon: 'user' },
];

interface Props {
  session: Session | null;
  integrations: IntegrationStatus;
  onLogin: (session: Session) => void;
  onLogout: () => void;
  onWebView: () => void;
}

// The app view: a mobile banking experience with bottom navigation. Shown in a phone frame on desktops.
export function MobileApp({ session, integrations, onLogin, onLogout, onWebView }: Props) {
  const [tab, setTab] = useState<Tab>('home');
  const [insight, setInsight] = useState<'forecast' | 'afford'>('forecast');
  const [activeCase, setActiveCase] = useState<CaseRecord | null>(null);
  const [caseOpen, setCaseOpen] = useState(false);
  const [seed, setSeed] = useState<{ text: string; nonce: number } | null>(null);

  const updateCase = useCallback((record: CaseRecord | null) => setActiveCase(record), []);
  const onCaseChange = useCallback((record: CaseRecord) => setActiveCase(record), []);

  if (!session) return <MobileLogin onLogin={onLogin} />;

  const ask = (message?: string) => {
    if (message) setSeed({ text: message, nonce: Date.now() });
    setTab('saathi');
  };
  const openCase = async (caseId: string) => {
    setActiveCase(await api.getCase(caseId));
    setCaseOpen(true);
  };

  return (
    <div className="m-app">
      <main className="m-screen">
        {tab === 'home' && (
          <MobileHome
            user={session.user}
            onAsk={ask}
            onOpen={(next, section) => {
              if (section) setInsight(section);
              setTab(next);
            }}
          />
        )}
        {tab === 'saathi' && (
          <MobileSaathi
            integrations={integrations}
            activeCase={activeCase}
            onCase={updateCase}
            onOpenCase={() => setCaseOpen(true)}
            seed={seed}
            onSeedUsed={() => setSeed(null)}
          />
        )}
        {tab === 'insights' && <MobileInsights section={insight} onSection={setInsight} onAsk={(message) => ask(message)} />}
        {tab === 'activity' && <MobileActivity onOpen={(caseId) => void openCase(caseId)} refreshKey={activeCase?.updated_at ?? ''} />}
        {tab === 'profile' && <MobileProfile user={session.user} onLogout={onLogout} onWebView={onWebView} />}
      </main>

      {caseOpen && activeCase && (
        <div className="m-overlay">
          <MobileCase caseRecord={activeCase} integrations={integrations} onChange={onCaseChange} onClose={() => setCaseOpen(false)} />
        </div>
      )}

      <nav className="m-nav" aria-label="Main">
        {NAV.map((item) => (
          <button
            key={item.id}
            className={`${tab === item.id ? 'active' : ''} ${item.id === 'saathi' ? 'center' : ''}`}
            onClick={() => {
              setCaseOpen(false);
              setTab(item.id);
            }}
            aria-current={tab === item.id ? 'page' : undefined}
          >
            <span className="m-nav-icon">
              <Icon name={item.icon} size={item.id === 'saathi' ? 26 : 22} />
            </span>
            <span>{item.label}</span>
          </button>
        ))}
      </nav>
    </div>
  );
}
