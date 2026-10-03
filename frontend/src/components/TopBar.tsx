import type { ReactNode } from 'react';
import { initials } from '../mobile/MobileLogin';
import type { IntegrationStatus, Session } from '../types';

interface Props {
  session: Session | null;
  apiOnline: boolean | null;
  integrations: IntegrationStatus;
  onLogout: () => void;
  viewToggle?: ReactNode;
}

export function TopBar({ session, apiOnline, onLogout, viewToggle }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="topbar-wordmark">
          Paytm <b>Saathi</b>
        </span>
      </div>
      {apiOnline === false && <span className="topbar-offline">Saathi is offline</span>}
      <div className="topbar-actions">
        {viewToggle}
        {session && (
          <div className="topbar-user">
            <span className="topbar-avatar" aria-hidden>
              {initials(session.user.display_name)}
            </span>
            <span className="topbar-name">{session.user.display_name.split(' ')[0]}</span>
            <button className="btn btn-ghost" onClick={onLogout}>
              Sign out
            </button>
          </div>
        )}
      </div>
    </header>
  );
}
