import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { api, ApiError } from '../api';
import { inr } from '../format';
import type { CashForecast } from '../types';

const PAD = { top: 30, right: 16, bottom: 28, left: 56 };

const shortDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });

function BalanceChart({ forecast }: { forecast: CashForecast }) {
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the container's real width so labels stay legible from phone to desktop.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [WIDTH, setWidth] = useState(1000);
  useEffect(() => {
    const element = wrapRef.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.max(Math.round(entry!.contentRect.width), 300)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const HEIGHT = WIDTH < 600 ? 250 : 300;
  const days = forecast.days;
  const inflow = days.map((day) => day.events.filter((event) => event.direction === 'in').reduce((sum, event) => sum + event.amount_inr, 0));
  const outflow = days.map((day) => day.events.filter((event) => event.direction === 'out').reduce((sum, event) => sum + event.amount_inr, 0));
  const values = days.map((day) => day.balance_inr);
  const min = Math.min(0, ...values, ...outflow.map((value) => -value));
  const max = Math.max(0, ...values, ...inflow);
  const pad = (max - min) * 0.08 || 1000;
  const top = max + pad;
  const bottom = min - pad;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const slot = innerW / days.length;
  const x = (index: number) => PAD.left + slot * index + slot / 2;
  const y = (value: number) => PAD.top + ((top - value) / (top - bottom)) * innerH;
  const zeroY = y(0);
  const barW = Math.max(Math.min(slot * 0.6, 18), 3);

  const line = days.map((day, index) => `${index === 0 ? 'M' : 'L'}${x(index)},${y(day.balance_inr)}`).join('');
  const area = `${line}L${x(days.length - 1)},${zeroY}L${x(0)},${zeroY}Z`;
  const step = Math.pow(10, Math.floor(Math.log10(Math.max(top - bottom, 1)))) / 2;
  const ticks: number[] = [];
  for (let tick = Math.ceil(bottom / step) * step; tick <= top; tick += step) ticks.push(tick);
  const labelEvery = Math.ceil(days.length / (WIDTH < 600 ? 4 : 8));
  const lowIndex = days.findIndex((day) => day.date === forecast.lowest.date);
  const paydayIndex = days.findIndex((day) => day.date === forecast.payday);
  const hovered = hover === null ? null : days[hover]!;
  const compact = (value: number) => `${value < 0 ? '−' : ''}₹${Math.abs(value) >= 100000 ? `${(Math.abs(value) / 100000).toFixed(1)}L` : `${Math.round(Math.abs(value) / 1000)}k`}`;

  const onMove = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * days.length);
    setHover(Math.max(0, Math.min(days.length - 1, index)));
  };

  return (
    <div className="bi-chart" ref={wrapRef}>
      <div className="bi-legend" aria-hidden>
        <span><i className="sw line" /> Balance</span>
        <span><i className="sw in" /> Money in</span>
        <span><i className="sw out" /> Money out</span>
      </div>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Balance and cash flow for ${days.length} days. ${forecast.headline}`}>
        <defs>
          <linearGradient id="bi-area" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0%" stopColor="#118dff" stopOpacity="0.35" />
            <stop offset="100%" stopColor="#118dff" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'bi-zero' : 'bi-grid'} />
            <text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end" className="bi-axis">
              {compact(tick)}
            </text>
          </g>
        ))}
        {days.map((day, index) =>
          index % labelEvery === 0 || index === days.length - 1 ? (
            <text key={day.date} x={x(index)} y={HEIGHT - 8} textAnchor="middle" className="bi-axis">
              {shortDate(day.date)}
            </text>
          ) : null,
        )}
        <path d={area} fill="url(#bi-area)" />
        {days.map((day, index) => (
          <g key={`bars-${day.date}`} opacity={hover === null || hover === index ? 1 : 0.45}>
            {inflow[index]! > 0 && (
              <rect x={x(index) - barW / 2} y={y(inflow[index]!)} width={barW} height={zeroY - y(inflow[index]!)} rx={3} className="bi-in" />
            )}
            {outflow[index]! > 0 && (
              <rect x={x(index) - barW / 2} y={zeroY} width={barW} height={y(-outflow[index]!) - zeroY} rx={3} className="bi-out" />
            )}
          </g>
        ))}
        <path d={line} className="bi-line" />
        {paydayIndex >= 0 && (
          <g>
            <line x1={x(paydayIndex)} x2={x(paydayIndex)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="bi-marker" />
            <text x={x(paydayIndex)} y={PAD.top - 10} textAnchor="middle" className="bi-marker-label">
              Payday
            </text>
          </g>
        )}
        {lowIndex >= 0 && forecast.lowest.balance_inr < 0 && (
          <g>
            <circle cx={x(lowIndex)} cy={y(forecast.lowest.balance_inr)} r={5} className="bi-low" />
            <text
              x={x(lowIndex) - PAD.left < 130 ? x(lowIndex) + 10 : x(lowIndex) - 10}
              y={y(forecast.lowest.balance_inr) + 4}
              textAnchor={x(lowIndex) - PAD.left < 130 ? 'start' : 'end'}
              className="bi-low-label"
            >
              Lowest {compact(forecast.lowest.balance_inr)}
            </text>
          </g>
        )}
        {hovered && (
          <g pointerEvents="none">
            <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="bi-crosshair" />
            <circle cx={x(hover!)} cy={y(hovered.balance_inr)} r={4.5} className="bi-dot" />
          </g>
        )}
        <rect
          x={PAD.left}
          y={0}
          width={innerW}
          height={HEIGHT}
          fill="transparent"
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          tabIndex={0}
          onFocus={() => setHover(0)}
          onBlur={() => setHover(null)}
          onKeyDown={(event) => {
            if (event.key === 'ArrowRight') setHover((current) => Math.min((current ?? -1) + 1, days.length - 1));
            if (event.key === 'ArrowLeft') setHover((current) => Math.max((current ?? 1) - 1, 0));
          }}
          aria-label="Move across the chart to read each day"
        />
      </svg>
      {hovered && (
        <div className="chart-tooltip" style={{ left: `${(x(hover!) / WIDTH) * 100}%` }}>
          <strong>{shortDate(hovered.date)}</strong>
          <span className={hovered.balance_inr < 0 ? 'neg' : ''}>Balance {inr(hovered.balance_inr)}</span>
          {hovered.events.map((event) => (
            <small key={event.id}>
              {event.direction === 'in' ? '+' : '−'}
              {inr(event.amount_inr)} {event.title}
            </small>
          ))}
        </div>
      )}
    </div>
  );
}

export function ForecastCard({ onAsk }: { onAsk: (message: string) => void }) {
  const [forecast, setForecast] = useState<CashForecast | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [delay, setDelay] = useState(0);
  const [horizon, setHorizon] = useState(30);
  const [skip, setSkip] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .forecast(delay, skip, horizon)
      .then((result) => !cancelled && setForecast(result))
      .catch((caught) => !cancelled && setError(caught instanceof ApiError ? caught.message : 'Could not build the forecast.'));
    return () => {
      cancelled = true;
    };
  }, [delay, skip, horizon]);

  const optional = useMemo(() => (forecast?.items ?? []).filter((item) => item.flexible), [forecast]);
  if (error) return <section className="card home-section"><p className="alert alert-error">{error}</p></section>;
  if (!forecast) return <section className="card home-section"><p className="muted">Building your cash-flow forecast...</p></section>;
  const bestIds = new Set(forecast.best_plan?.fix_ids ?? []);

  return (
    <section className="card home-section forecast">
      <div className="row space-between wrap">
        <div>
          <p className="eyebrow">Cash-flow Copilot</p>
          <h3>Projected balance, next {forecast.horizon_days} days</h3>
        </div>
        <div className="forecast-stats">
          <div>
            <small>Lowest before payday</small>
            <strong className={forecast.lowest.balance_inr < 0 ? 'neg' : ''}>{inr(forecast.lowest.balance_inr)}</strong>
          </div>
          <div>
            <small>Safe to spend now</small>
            <strong>{inr(forecast.safe_to_spend_inr)}</strong>
          </div>
        </div>
      </div>
      <p className={forecast.crunch_inr > 0 ? 'alert alert-warn' : 'alert alert-info'}>{forecast.headline}</p>
      <div className="bi-kpis">
        <div>
          <small>Opening</small>
          <strong>{inr(forecast.opening_balance_inr)}</strong>
        </div>
        <div>
          <small>Lowest</small>
          <strong className={forecast.lowest.balance_inr < 0 ? 'neg' : ''}>{inr(forecast.lowest.balance_inr)}</strong>
        </div>
        <div>
          <small>Payday</small>
          <strong>{shortDate(forecast.payday)}</strong>
        </div>
        <div>
          <small>End of period</small>
          <strong>{inr(forecast.end_balance_inr)}</strong>
        </div>
      </div>
      <div className="bi-filter" role="radiogroup" aria-label="Period">
        {[7, 14, 30].map((days) => (
          <button key={days} role="radio" aria-checked={horizon === days} className={horizon === days ? 'active' : ''} onClick={() => setHorizon(days)}>
            {days}D
          </button>
        ))}
      </div>
      <BalanceChart forecast={forecast} />

      <div className="whatif">
        <label>
          What if my salary is late by{' '}
          <select value={delay} onChange={(event) => setDelay(Number(event.target.value))}>
            {[0, 3, 5, 7, 10].map((days) => (
              <option key={days} value={days}>
                {days} day{days === 1 ? '' : 's'}
              </option>
            ))}
          </select>
        </label>
        {optional.map((item) => (
          <label key={item.id} className="checkbox">
            <input
              type="checkbox"
              checked={skip.includes(item.id)}
              onChange={(event) => setSkip((current) => (event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id)))}
            />
            Skip {item.title} ({inr(item.amount_inr)})
          </label>
        ))}
      </div>

      {forecast.fixes.length > 0 && forecast.crunch_inr > 0 && (
        <div className="fixes">
          <h4>Ways to close the {inr(forecast.crunch_inr)} gap</h4>
          {forecast.best_plan && (
            <p className="alert alert-info">
              <strong>Cheapest plan:</strong> {forecast.best_plan.summary}
              {forecast.plan_without_new_loan && (
                <>
                  <br />
                  <strong>Without a new loan:</strong> {forecast.plan_without_new_loan.summary}
                </>
              )}
            </p>
          )}
          <ul>
            {forecast.fixes.map((fix) => (
              <li key={fix.id} className={bestIds.has(fix.id) ? 'fix best' : 'fix'}>
                <div>
                  <strong>{fix.title}</strong>
                  <small className="muted">{fix.detail}</small>
                </div>
                <div className="fix-side">
                  <small>Frees {inr(fix.relief_inr)}</small>
                  <small>{fix.cost_inr ? `Costs about ${inr(fix.cost_inr)}` : 'No cost'}</small>
                  {fix.playbook_message && (
                    <button className="btn" onClick={() => onAsk(fix.playbook_message!)}>
                      Start this
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}

      <details className="table-view">
        <summary>Show the forecast as a table</summary>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>What happens</th>
              <th className="num">Balance</th>
            </tr>
          </thead>
          <tbody>
            {forecast.days
              .filter((day, index) => day.events.length || index === 0)
              .map((day) => (
                <tr key={day.date}>
                  <td>{shortDate(day.date)}</td>
                  <td>{day.events.length ? day.events.map((event) => `${event.direction === 'in' ? '+' : '−'}${inr(event.amount_inr)} ${event.title}`).join(', ') : 'Opening balance'}</td>
                  <td className={`num ${day.balance_inr < 0 ? 'neg' : ''}`}>{inr(day.balance_inr)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </details>
      <small className="muted">{forecast.method}</small>
    </section>
  );
}
