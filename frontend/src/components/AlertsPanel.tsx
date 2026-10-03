import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import type { ProactiveAlert } from '../types';

interface Props {
  busy: boolean;
  onStart: (message: string) => void;
  refreshKey: string;
}

// "Saathi noticed" cards: deterministic watchers over the customer's own records, opt-in only.
export function AlertsPanel({ busy, onStart, refreshKey }: Props) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [alerts, setAlerts] = useState<ProactiveAlert[]>([]);

  const apply = (result: { enabled: boolean; alerts: ProactiveAlert[] }) => {
    setEnabled(result.enabled);
    setAlerts(result.alerts);
  };

  const load = useCallback(async () => {
    try {
      apply(await api.alerts());
    } catch {
      setEnabled(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  if (enabled === null) return null;

  if (!enabled) {
    return (
      <div className="alert-optin">
        <span>
          <strong>Let Saathi watch for problems.</strong> Get a heads-up about EMI shortfalls and suspicious debits before they
          hurt. Saathi checks only your own records; nothing is shared.
        </span>
        <button className="btn" onClick={async () => apply(await api.setAlerts(true))}>
          Turn on alerts
        </button>
      </div>
    );
  }

  if (!alerts.length) {
    return (
      <p className="muted small alerts-quiet">
        Saathi is watching your accounts. Nothing needs attention.{' '}
        <button className="link" onClick={async () => apply(await api.setAlerts(false))}>
          Turn off
        </button>
      </p>
    );
  }

  return (
    <div className="alerts">
      {alerts.map((alert) => (
        <div key={alert.alert_id} className={`alert-card alert-card-${alert.severity}`}>
          <div>
            <p className="eyebrow">Saathi noticed</p>
            <strong>{alert.title}</strong>
            <p className="muted small">{alert.detail}</p>
          </div>
          <div className="alert-card-actions">
            <button className="btn btn-primary" disabled={busy} onClick={() => onStart(alert.suggested_message)}>
              See my options
            </button>
            <button className="link" onClick={async () => apply(await api.dismissAlert(alert.alert_id))}>
              Dismiss
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
