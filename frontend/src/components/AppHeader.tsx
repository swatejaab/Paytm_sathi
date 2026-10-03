import { useEffect, useRef, useState } from 'react';
import { navigate, routeHref, type Page } from '../router';
import type { Theme } from '../theme';
import type { SessionUser } from '../types';
import type { ViewMode } from '../viewMode';
import { AssistantMark, BrandMark, Icon, type IconName } from './Icon';
import { SosButton } from './MoneySos';
import { ViewToggle } from './ViewToggle';

export const NAV: { page: Page; label: string; icon: IconName }[] = [
  { page: 'home', label: 'Home', icon: 'home' },
  { page: 'insights', label: 'Insights', icon: 'insights' },
  { page: 'saathi', label: 'Saathi', icon: 'chat' },
  { page: 'goals', label: 'Goals', icon: 'target' },
  { page: 'more', label: 'More', icon: 'grid' },
];

export function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="icon-btn theme-toggle" onClick={onToggle} aria-label={`Switch to ${next} theme`} title={`Switch to ${next} theme`}>
      <Icon name={theme === 'dark' ? 'sun' : 'moon'} />
    </button>
  );
}

function UserMenu({ user, onLogout }: { user: SessionUser; onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => !ref.current?.contains(event.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const go = (section: string) => {
    setOpen(false);
    navigate('more', section);
  };
  const initials = user.display_name
    .split(' ')
    .map((part) => part[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="user-menu" ref={ref}>
      <button className="avatar-btn" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
        <span className="avatar">{initials}</span>
      </button>
      {open && (
        <div className="menu" role="menu">
          <div className="menu-head">
            <strong>{user.display_name}</strong>
            <small>{user.role === 'support' ? 'Saathi specialist' : 'Paytm account'}</small>
          </div>
          {user.role === 'customer' && (
            <>
              <button role="menuitem" onClick={() => go('profile')}>
                <Icon name="user" size={18} /> Profile
              </button>
              <button role="menuitem" onClick={() => go('consents')}>
                <Icon name="shield" size={18} /> Privacy & consent
              </button>
            </>
          )}
          <button role="menuitem" className="danger" onClick={onLogout}>
            <Icon name="logout" size={18} /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

interface Props {
  user: SessionUser | null;
  page: Page;
  theme: Theme;
  onToggleTheme: () => void;
  onLogout: () => void;
  viewMode?: ViewMode;
  onViewMode?: (mode: ViewMode) => void;
}

export function AppHeader({ user, page, theme, onToggleTheme, onLogout, viewMode, onViewMode }: Props) {
  const customer = user?.role === 'customer';
  return (
    <header className="app-header">
      <div className="header-inner">
        <a className="brand" href={routeHref('home')} aria-label="Paytm Saathi home">
          <BrandMark size={34} />
          <span className="brand-text">
            <strong>
              Paytm <span>Saathi</span>
            </strong>
          </span>
        </a>
        {customer && (
          <nav className="top-nav" aria-label="Main">
            {NAV.map((item) => (
              <a key={item.page} href={routeHref(item.page)} className={page === item.page ? 'active' : ''} aria-current={page === item.page ? 'page' : undefined}>
                {item.label}
              </a>
            ))}
          </nav>
        )}
        {user?.role === 'support' && <span className="header-tag">Specialist desk</span>}
        <div className="header-actions">
          {customer && <SosButton />}
          {viewMode && onViewMode && <ViewToggle mode={viewMode} onChange={onViewMode} />}
          <ThemeToggle theme={theme} onToggle={onToggleTheme} />
          {user && <UserMenu user={user} onLogout={onLogout} />}
        </div>
      </div>
    </header>
  );
}

export function BottomNav({ page }: { page: Page }) {
  return (
    <nav className="bottom-nav" aria-label="Main">
      {NAV.map((item) =>
        item.page === 'saathi' ? (
          <a
            key={item.page}
            href={routeHref(item.page)}
            className={`nav-saathi ${page === item.page ? 'active' : ''}`}
            aria-current={page === item.page ? 'page' : undefined}
            aria-label="Saathi AI assistant"
          >
            <span className="nav-orb">
              <AssistantMark size={44} />
            </span>
            <span>Saathi AI</span>
          </a>
        ) : (
          <a key={item.page} href={routeHref(item.page)} className={page === item.page ? 'active' : ''} aria-current={page === item.page ? 'page' : undefined}>
            <Icon name={item.icon} size={22} />
            <span>{item.label}</span>
          </a>
        ),
      )}
    </nav>
  );
}
