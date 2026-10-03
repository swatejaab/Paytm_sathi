import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import { api, ApiError } from '../api';
import { inr } from '../format';
import type { CashForecast } from '../types';

const PAD = { top: 34, right: 20, bottom: 30, left: 72 };

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
  const HEIGHT = WIDTH < 600 ? 230 : 280;
  const days = forecast.days;
  const values = days.map((day) => day.balance_inr);
  const min = Math.min(0, ...values);
  const max = Math.max(0, ...values);
  const span = max - min || 1;
  const innerW = WIDTH - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + (index / Math.max(days.length - 1, 1)) * innerW;
  const y = (value: number) => PAD.top + ((max - value) / span) * innerH;
  const zeroY = y(0);

  // Step line: the balance holds until the next event day.
  const path = days
    .map((day, index) => (index === 0 ? `M${x(0)},${y(day.balance_inr)}` : `H${x(index)}V${y(day.balance_inr)}`))
    .join('');
  const area = `${path}H${x(days.length - 1)}V${zeroY}H${x(0)}Z`;
  const lowIndex = days.findIndex((day) => day.date === forecast.lowest.date);
  const paydayIndex = days.findIndex((day) => day.date === forecast.payday);
  const ticks = [max, (max + min) / 2, min].map((value) => Math.round(value / 1000) * 1000);

  const onMove = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const ratio = (event.clientX - box.left) / box.width;
    setHover(Math.max(0, Math.min(days.length - 1, Math.round(ratio * (days.length - 1)))));
  };
  const hovered = hover === null ? null : days[hover]!;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={`Projected balance for ${days.length} days. ${forecast.headline}`}>
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} className="chart-grid" />
            <text x={PAD.left - 8} y={y(tick) + 4} textAnchor="end" className="chart-axis">
              {inr(tick)}
            </text>
          </g>
        ))}
        {min < 0 && (
          <>
            <rect x={PAD.left} y={zeroY} width={innerW} height={HEIGHT - PAD.bottom - zeroY} className="chart-negative" />
            <text x={WIDTH - PAD.right - 6} y={HEIGHT - PAD.bottom - 6} textAnchor="end" className="chart-negative-label">
              Below zero
            </text>
          </>
        )}
        <path d={area} className="chart-area" />
        <line x1={PAD.left} x2={WIDTH - PAD.right} y1={zeroY} y2={zeroY} className="chart-zero" />
        <path d={path} className="chart-line" />
        {paydayIndex >= 0 && (
          <g>
            <line x1={x(paydayIndex)} x2={x(paydayIndex)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="chart-payday" />
            <text x={x(paydayIndex)} y={PAD.top - 10} textAnchor="middle" className="chart-payday-label">
              Payday {shortDate(forecast.payday)}
            </text>
          </g>
        )}
        {lowIndex >= 0 && forecast.lowest.balance_inr < 0 && (
          <g>
            <circle cx={x(lowIndex)} cy={y(forecast.lowest.balance_inr)} r={5} className="chart-low" />
            <text
              x={x(lowIndex) - PAD.left < 130 ? x(lowIndex) + 10 : x(lowIndex) - 10}
              y={y(forecast.lowest.balance_inr) - 8}
              textAnchor={x(lowIndex) - PAD.left < 130 ? 'start' : 'end'}
              className="chart-low-label"
            >
              Lowest {inr(forecast.lowest.balance_inr)}
            </text>
          </g>
        )}
        {[0, Math.floor((days.length - 1) / 2), days.length - 1].map((index) => (
          <text key={index} x={x(index)} y={HEIGHT - 10} textAnchor={index === 0 ? 'start' : index === days.length - 1 ? 'end' : 'middle'} className="chart-axis">
            {shortDate(days[index]!.date)}
          </text>
        ))}
        {hovered && (
          <g pointerEvents="none">
            <line x1={x(hover!)} x2={x(hover!)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="chart-crosshair" />
            <circle cx={x(hover!)} cy={y(hovered.balance_inr)} r={4.5} className="chart-dot" />
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
          aria-label="Move across the chart to read each day's balance"
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
  const [skip, setSkip] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    api
      .forecast(delay, skip)
      .then((result) => !cancelled && setForecast(result))
      .catch((caught) => !cancelled && setError(caught instanceof ApiError ? caught.message : 'Could not build the forecast.'));
    return () => {
      cancelled = true;
    };
  }, [delay, skip]);

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
