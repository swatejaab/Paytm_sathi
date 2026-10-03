import type { ReactNode } from 'react';
import type { IntegrationStatus, Session } from '../types';

interface Props {
  session: Session | null;
  apiOnline: boolean | null;
  integrations: IntegrationStatus;
  onLogout: () => void;
  viewToggle?: ReactNode;
}

function Pill({ ok, label, title }: { ok: boolean | null; label: string; title?: string }) {
  return (
    <span className={`pill ${ok === null ? 'pill-muted' : ok ? 'pill-ok' : 'pill-off'}`} title={title}>
      <span className="dot" />
      {label}
    </span>
  );
}

export function TopBar({ session, apiOnline, integrations, onLogout, viewToggle }: Props) {
  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-mark" aria-hidden>
          ♡
        </span>
        <div>
          <strong>Paytm Saathi</strong>
          <small>Financial first aid / Track 2</small>
        </div>
      </div>
      <div className="topbar-status">
        <Pill ok={apiOnline} label={apiOnline === false ? 'API offline' : 'API'} />
        <Pill ok={integrations.openai_available} label="OpenAI" title="Evidence summaries, consent per request" />
        <Pill ok={integrations.sarvam_available} label="Sarvam voice" title="Hindi/Hinglish transcription" />
        <Pill
          ok={true}
          label={integrations.partner_channel === 'n8n' ? 'Partners: n8n' : 'Partners: simulated'}
          title="Approved actions are sent through this channel"
        />
      </div>
      {viewToggle}
      {session && (
        <div className="topbar-user">
          <span>
            {session.user.display_name}
            <small>{session.user.role}</small>
          </span>
          <button className="btn btn-ghost" onClick={onLogout}>
            Sign out
          </button>
        </div>
      )}
    </header>
  );
}
