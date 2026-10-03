import { useState } from 'react';
import { api, ApiError } from '../api';
import type { CreditScore, ScoreSimulation } from '../types';

const ACTIONS: { id: ScoreSimulation['action']; label: string }[] = [
  { id: 'pay_card_to_10', label: 'Pay card to 10%' },
  { id: 'take_small_loan', label: 'Take a ₹15k loan' },
  { id: 'miss_one_emi', label: 'Miss one EMI' },
  { id: 'close_oldest_card', label: 'Close oldest card' },
];

// Semi-circular meter for one score on 300-900; the number and band are always printed as text.
function Gauge({ score, tone, band }: { score: number; tone: string; band: string }) {
  const ratio = (score - 300) / 600;
  const radius = 80;
  const circumference = Math.PI * radius;
  return (
    <div className="credit-gauge" role="img" aria-label={`Credit score ${score} of 900, ${band}`}>
      <svg viewBox="0 0 200 116">
        <path d="M20 100 A80 80 0 0 1 180 100" className="gauge-track" />
        <path
          d="M20 100 A80 80 0 0 1 180 100"
          className={`gauge-fill tone-${tone}`}
          strokeDasharray={`${circumference * ratio} ${circumference}`}
        />
        <text x="20" y="114" className="gauge-scale" textAnchor="middle">300</text>
        <text x="180" y="114" className="gauge-scale" textAnchor="middle">900</text>
      </svg>
      <div className="gauge-center">
        <strong>{score}</strong>
        <span className={`credit-band tone-${tone}`}>{band}</span>
      </div>
    </div>
  );
}

export function CreditScoreCard() {
  const [consented, setConsented] = useState(false);
  const [credit, setCredit] = useState<CreditScore | null>(null);
  const [simulation, setSimulation] = useState<ScoreSimulation | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      setCredit(await api.creditScore());
      setConsented(true);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not fetch your credit score.');
    } finally {
      setBusy(false);
    }
  };

  const simulate = async (action: ScoreSimulation['action']) => {
    setBusy(true);
    try {
      setSimulation(await api.simulateScore(action));
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : 'Could not run that scenario.');
    } finally {
      setBusy(false);
    }
  };

  if (!consented || !credit) {
    return (
      <section className="card home-section credit">
        <p className="eyebrow">Credit health</p>
        <h3>Check your credit score</h3>
        <p className="muted small">A soft check: it does not affect your score. Saathi reads your report only for you, only now.</p>
        <button className="btn btn-primary" disabled={busy} onClick={() => void check()}>
          {busy ? 'Checking…' : 'Allow soft check and show my score'}
        </button>
        {error && <p className="alert alert-error">{error}</p>}
      </section>
    );
  }

  return (
    <section className="card home-section credit">
      <div className="row space-between wrap">
        <div>
          <p className="eyebrow">Credit health</p>
          <h3>Your credit score</h3>
        </div>
        <small className="muted">As of {new Date(`${credit.report.as_of}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</small>
      </div>
      <Gauge score={credit.score} tone={credit.tone} band={credit.band} />

      <ul className="credit-factors">
        {credit.factors.map((factor) => (
          <li key={factor.id}>
            <span className={`factor-dot ${factor.status}`} aria-hidden />
            <span className="factor-main">
              <strong>{factor.label}</strong>
              <small className="muted">{factor.value}</small>
            </span>
            <span className={`factor-status ${factor.status}`}>{factor.status === 'good' ? 'Good' : factor.status === 'fair' ? 'Fair' : 'Needs work'}</span>
          </li>
        ))}
      </ul>
      {credit.factors.filter((factor) => factor.status !== 'good').slice(0, 1).map((factor) => (
        <p key={factor.id} className="alert alert-info small">
          <strong>Best next step:</strong> {factor.tip}
        </p>
      ))}

      <div className="credit-sim">
        <h4>What if I…</h4>
        <div className="mode-chips">
          {ACTIONS.map((action) => (
            <button key={action.id} className={`mode-chip ${simulation?.action === action.id ? 'selected' : ''}`} disabled={busy} onClick={() => void simulate(action.id)}>
              <span>{action.label}</span>
            </button>
          ))}
        </div>
        {simulation && (
          <p className={`sim-result ${simulation.delta >= 0 ? 'up' : 'down'}`}>
            <strong>
              {simulation.after} ({simulation.delta >= 0 ? '+' : ''}
              {simulation.delta})
            </strong>{' '}
            {simulation.label}. {simulation.changed.map((factor) => `${factor.label} ${factor.delta > 0 ? '+' : ''}${factor.delta}`).join(', ')}
          </p>
        )}
      </div>
      <small className="muted">{credit.bureau}. Saathi's transparent estimate; real bureaus such as CIBIL use their own models.</small>
    </section>
  );
}
