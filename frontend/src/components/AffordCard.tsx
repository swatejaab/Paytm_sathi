import { useState } from 'react';
import { api, ApiError } from '../api';
import { inr } from '../format';
import type { AffordabilityAssessment } from '../types';

const PRESETS = ['Can I afford a ₹1.2 lakh iPhone?', 'Can I afford a ₹60,000 laptop?', 'Can I afford an ₹8 lakh car?'];

const STATUS: Record<string, { label: string; className: string }> = {
  comfortable: { label: 'Comfortable', className: 'badge-green' },
  manageable: { label: 'Manageable', className: 'badge-amber' },
  high_stress: { label: 'High stress', className: 'badge-red' },
  not_possible: { label: 'Not possible', className: 'badge-red' },
  wait: { label: 'Strongest position', className: 'badge-blue' },
};

export function AffordCard() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState<AffordabilityAssessment | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const ask = async (text: string) => {
    setQuestion(text);
    setBusy(true);
    setError(null);
    try {
      setResult(await api.afford(text));
    } catch (caught) {
      setResult(null);
      setError(caught instanceof ApiError ? caught.message : 'Could not check that purchase.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card home-section afford" id="afford">
      <p className="eyebrow">ASK / PROTECT</p>
      <h3>Can I afford it?</h3>
      <div className="composer">
        <textarea
          rows={1}
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder="Can I afford a ₹1.2 lakh iPhone?"
          maxLength={300}
        />
        <button className="btn btn-primary" disabled={busy || question.trim().length < 3} onClick={() => void ask(question.trim())}>
          {busy ? 'Checking...' : 'Check'}
        </button>
      </div>
      <div className="mode-chips">
        {PRESETS.map((preset) => (
          <button key={preset} className="mode-chip" onClick={() => void ask(preset)}>
            <span>{preset.replace('Can I afford ', '').replace('?', '')}</span>
          </button>
        ))}
      </div>
      {error && <p className="alert alert-error">{error}</p>}
      {result && (
        <div className="afford-result">
          <p className={`alert ${result.verdict === 'yes' ? 'alert-info' : result.verdict === 'yes_with_plan' ? 'alert-warn' : 'alert-error'}`}>
            <strong>{result.verdict === 'yes' ? 'Yes. ' : result.verdict === 'yes_with_plan' ? 'Yes, with a plan. ' : 'Not now. '}</strong>
            {result.headline}
          </p>
          {result.warning && <p className="alert alert-warn">{result.warning}</p>}
          <table className="table">
            <thead>
              <tr>
                <th>Scenario</th>
                <th className="num">Upfront</th>
                <th className="num">EMI</th>
                <th className="num">Extra cost</th>
                <th>Effect</th>
              </tr>
            </thead>
            <tbody>
              {result.scenarios.map((scenario) => (
                <tr key={scenario.id} className={scenario.id === result.recommended_id ? 'recommended-row' : ''}>
                  <td>
                    <strong>{scenario.title}</strong>
                    {scenario.id === result.recommended_id && <span className="badge badge-blue">Saathi suggests</span>}
                    <br />
                    <span className={`badge ${STATUS[scenario.status]!.className}`}>{STATUS[scenario.status]!.label}</span>
                  </td>
                  <td className="num">{scenario.upfront_inr ? inr(scenario.upfront_inr) : '—'}</td>
                  <td className="num">{scenario.monthly_emi_inr ? `${inr(scenario.monthly_emi_inr)} × ${scenario.months}` : '—'}</td>
                  <td className="num">{scenario.extra_cost_inr ? inr(scenario.extra_cost_inr) : '₹0'}</td>
                  <td className="small">{scenario.effect}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <small className="muted">
            {inr(result.context.free_balance_inr)} free before payday, {inr(result.context.spare_savings_inr)} of savings above your{' '}
            {inr(result.context.emergency_buffer_inr)} buffer, {inr(result.context.free_cash_monthly_inr)} free cash a month. {result.method} You decide;
            Saathi explains the consequences.
          </small>
        </div>
      )}
    </section>
  );
}
