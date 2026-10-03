import { useEffect, useId, useMemo, useRef, useState, type PointerEvent } from 'react';
import { api, errorMessage } from '../api';
import { inr, inrCompact } from '../format';
import type { CashForecast } from '../types';
import { Icon } from './Icon';

const shortDate = (date: string) => new Date(`${date}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
const DELAYS = [0, 3, 5, 7, 10];

function niceTicks(min: number, max: number, count = 5): number[] {
  const span = Math.max(max - min, 1);
  const raw = span / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw)!;
  const start = Math.floor(min / step) * step;
  const end = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let value = start; value <= end + step / 2; value += step) ticks.push(Math.round(value));
  return ticks;
}

interface DayPoint {
  date: string;
  balance: number;
  inflow: number;
  outflow: number;
  events: CashForecast['days'][number]['events'];
}

function useWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    observer.observe(element);
    setWidth(Math.floor(element.getBoundingClientRect().width));
    return () => observer.disconnect();
  }, []);
  return [ref, width] as const;
}

function ComboChart({ forecast, points }: { forecast: CashForecast; points: DayPoint[] }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<number | null>(null);
  const uid = useId().replace(/:/g, '');
  const compact = width < 560;
  const height = compact ? 280 : 340;
  const pad = { top: 26, right: compact ? 14 : 22, bottom: 32, left: compact ? 48 : 60 };
  const plotW = Math.max(width - pad.left - pad.right, 10);
  const plotH = height - pad.top - pad.bottom;

  const lo = Math.min(0, ...points.map((point) => Math.min(point.balance, -point.outflow)));
  const hi = Math.max(1, ...points.map((point) => Math.max(point.balance, point.inflow)));
  const ticks = niceTicks(lo, hi, compact ? 4 : 5);
  const yMin = ticks[0]!;
  const yMax = ticks.at(-1)!;
  const band = plotW / points.length;
  const x = (index: number) => pad.left + band * index + band / 2;
  const y = (value: number) => pad.top + ((yMax - value) / (yMax - yMin || 1)) * plotH;
  const zeroY = y(0);
  const barW = Math.max(Math.min(band * 0.56, 16), 2);

  const line = points.map((point, index) => `${index ? 'L' : 'M'}${x(index).toFixed(1)},${y(point.balance).toFixed(1)}`).join('');
  const area = `${line}L${x(points.length - 1).toFixed(1)},${zeroY.toFixed(1)}L${x(0).toFixed(1)},${zeroY.toFixed(1)}Z`;
  const lowIndex = points.findIndex((point) => point.date === forecast.lowest.date);
  const paydayIndex = points.findIndex((point) => point.date === forecast.payday);
  const labelEvery = Math.max(1, Math.ceil(points.length / (compact ? 5 : 8)));

  const pick = (event: PointerEvent<SVGRectElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    const index = Math.floor(((event.clientX - box.left) / box.width) * points.length);
    setHover(Math.max(0, Math.min(points.length - 1, index)));
  };
  const hovered = hover === null ? null : points[hover]!;
  const tipLeft = hover === null ? 0 : Math.min(Math.max(x(hover), 110), Math.max(width - 110, 110));

  return (
    <div className="pbi-chart" ref={ref} onPointerLeave={() => setHover(null)}>
      <ul className="pbi-legend" aria-hidden>
        <li>
          <i className="sw sw-line" /> Balance
        </li>
        <li>
          <i className="sw sw-in" /> Money in
        </li>
        <li>
          <i className="sw sw-out" /> Money out
        </li>
        <li>
          <i className="sw sw-payday" /> Payday
        </li>
      </ul>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Projected daily balance for ${points.length} days. ${forecast.headline}`}>
          <defs>
            <linearGradient id={`${uid}-pos`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor="var(--chart-1)" stopOpacity="0.32" />
              <stop offset="1" stopColor="var(--chart-1)" stopOpacity="0.02" />
            </linearGradient>
            <clipPath id={`${uid}-above`}>
              <rect x={pad.left} y={pad.top} width={plotW} height={Math.max(zeroY - pad.top, 0)} />
            </clipPath>
            <clipPath id={`${uid}-below`}>
              <rect x={pad.left} y={zeroY} width={plotW} height={Math.max(pad.top + plotH - zeroY, 0)} />
            </clipPath>
          </defs>

          {ticks.map((tick) => (
            <g key={tick}>
              <line x1={pad.left} x2={width - pad.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'pbi-zero' : 'pbi-grid'} />
              <text x={pad.left - 8} y={y(tick) + 4} textAnchor="end" className="pbi-axis">
                {inrCompact(tick)}
              </text>
            </g>
          ))}

          {hover !== null && <rect x={x(hover) - band / 2} y={pad.top} width={band} height={plotH} className="pbi-hover" />}

          {points.map((point, index) => (
            <g key={point.date}>
              {point.inflow > 0 && <rect x={x(index) - barW / 2} y={y(point.inflow)} width={barW} height={Math.max(zeroY - y(point.inflow), 1)} rx={2} className="pbi-bar-in" />}
              {point.outflow > 0 && <rect x={x(index) - barW / 2} y={zeroY} width={barW} height={Math.max(y(-point.outflow) - zeroY, 1)} rx={2} className="pbi-bar-out" />}
            </g>
          ))}

          <path d={area} fill={`url(#${uid}-pos)`} clipPath={`url(#${uid}-above)`} />
          <path d={area} className="pbi-area-neg" clipPath={`url(#${uid}-below)`} />
          <path d={line} className="pbi-line" clipPath={`url(#${uid}-above)`} />
          <path d={line} className="pbi-line pbi-line-neg" clipPath={`url(#${uid}-below)`} />
          {points.map((point, index) =>
            point.events.length ? <circle key={point.date} cx={x(index)} cy={y(point.balance)} r={3} className={point.balance < 0 ? 'pbi-marker neg' : 'pbi-marker'} /> : null,
          )}

          {paydayIndex >= 0 && (
            <g className="pbi-payday">
              <line x1={x(paydayIndex)} x2={x(paydayIndex)} y1={pad.top} y2={pad.top + plotH} />
              <rect x={x(paydayIndex) - 38} y={pad.top - 22} width={76} height={18} rx={9} />
              <text x={x(paydayIndex)} y={pad.top - 9} textAnchor="middle">
                Payday {shortDate(forecast.payday)}
              </text>
            </g>
          )}

          <g className="pbi-label">
            <text x={x(0) + 6} y={y(points[0]!.balance) - 10}>
              {inrCompact(points[0]!.balance)}
            </text>
          </g>
          {lowIndex >= 0 && forecast.lowest.balance_inr < points[0]!.balance && (
            <g className={`pbi-callout ${forecast.lowest.balance_inr < 0 ? 'neg' : ''}`}>
              <circle cx={x(lowIndex)} cy={y(forecast.lowest.balance_inr)} r={6} />
              <text
                x={x(lowIndex) + (x(lowIndex) > width - 150 ? -10 : 10)}
                y={y(forecast.lowest.balance_inr) + 18}
                textAnchor={x(lowIndex) > width - 150 ? 'end' : 'start'}
              >
                Lowest {inrCompact(forecast.lowest.balance_inr)} · {shortDate(forecast.lowest.date)}
              </text>
            </g>
          )}
          <g className="pbi-label">
            <text x={x(points.length - 1)} y={y(points.at(-1)!.balance) - 10} textAnchor="end">
              {inrCompact(points.at(-1)!.balance)}
            </text>
          </g>

          {points.map((point, index) =>
            index % labelEvery === 0 || index === points.length - 1 ? (
              <text key={point.date} x={x(index)} y={height - 10} textAnchor="middle" className="pbi-axis">
                {shortDate(point.date)}
              </text>
            ) : null,
          )}

          {hovered && <circle cx={x(hover!)} cy={y(hovered.balance)} r={5} className="pbi-focus" />}
          <rect
            x={pad.left}
            y={pad.top}
            width={plotW}
            height={plotH}
            fill="transparent"
            onPointerMove={pick}
            onPointerDown={pick}
            tabIndex={0}
            onFocus={() => setHover(0)}
            onBlur={() => setHover(null)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight') setHover((current) => Math.min((current ?? -1) + 1, points.length - 1));
              if (event.key === 'ArrowLeft') setHover((current) => Math.max((current ?? 1) - 1, 0));
            }}
            aria-label="Move across the chart to read each day"
          />
        </svg>
      )}
      {hovered && (
        <div className="pbi-tip" style={{ left: tipLeft }} role="tooltip">
          <strong>{new Date(`${hovered.date}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short' })}</strong>
          <span>
            <i className="sw sw-line" />
            Balance <b className={hovered.balance < 0 ? 'neg' : ''}>{inr(hovered.balance)}</b>
          </span>
          {hovered.inflow > 0 && (
            <span>
              <i className="sw sw-in" />
              Money in <b>{inr(hovered.inflow)}</b>
            </span>
          )}
          {hovered.outflow > 0 && (
            <span>
              <i className="sw sw-out" />
              Money out <b>{inr(hovered.outflow)}</b>
            </span>
          )}
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

function OutflowBars({ items }: { items: { title: string; amount_inr: number; due_date: string }[] }) {
  const max = Math.max(...items.map((item) => item.amount_inr), 1);
  return (
    <ul className="pbi-bars">
      {items.map((item) => (
        <li key={`${item.title}-${item.due_date}`}>
          <div className="pbi-bars-head">
            <span>{item.title}</span>
            <strong>{inr(item.amount_inr)}</strong>
          </div>
          <div className="pbi-bars-track">
            <span style={{ width: `${(item.amount_inr / max) * 100}%` }} />
          </div>
          <small className="muted">Due {shortDate(item.due_date)}</small>
        </li>
      ))}
    </ul>
  );
}

function Tile({ label, value, note, tone }: { label: string; value: string; note?: string; tone?: 'neg' | 'pos' }) {
  return (
    <div className={`pbi-tile ${tone ?? ''}`}>
      <small>{label}</small>
      <strong>{value}</strong>
      {note && <span>{note}</span>}
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
      .catch((caught) => !cancelled && setError(errorMessage(caught)));
    return () => {
      cancelled = true;
    };
  }, [delay, skip]);

  const points = useMemo<DayPoint[]>(
    () =>
      (forecast?.days ?? []).map((day) => ({
        date: day.date,
        balance: day.balance_inr,
        events: day.events,
        inflow: day.events.filter((event) => event.direction === 'in').reduce((sum, event) => sum + event.amount_inr, 0),
        outflow: day.events.filter((event) => event.direction === 'out').reduce((sum, event) => sum + event.amount_inr, 0),
      })),
    [forecast],
  );
  const optional = useMemo(() => (forecast?.items ?? []).filter((item) => item.flexible), [forecast]);
  if (error) return <section className="card home-section"><p className="alert alert-error">{error}</p></section>;
  if (!forecast) return <section className="card home-section"><p className="muted">Building your cash-flow forecast...</p></section>;

  const bestIds = new Set(forecast.best_plan?.fix_ids ?? []);
  const moneyIn = points.reduce((sum, point) => sum + point.inflow, 0);
  const moneyOut = points.reduce((sum, point) => sum + point.outflow, 0);
  const beforePayday = forecast.items
    .filter((item) => item.direction === 'out' && item.due_date < forecast.payday && !skip.includes(item.id))
    .sort((a, b) => b.amount_inr - a.amount_inr)
    .slice(0, 6);

  return (
    <section className="card home-section forecast pbi">
      <header className="pbi-head">
        <div>
          <p className="eyebrow">Cash flow forecast</p>
          <h3>Projected balance, next {forecast.horizon_days} days</h3>
          <small className="muted">From {shortDate(forecast.as_of)} · salary {inr(forecast.salary_inr)} expected {shortDate(forecast.payday)}</small>
        </div>
      </header>

      <div className="pbi-tiles">
        <Tile label="Balance today" value={inr(forecast.opening_balance_inr)} />
        <Tile label={`Money in (${forecast.horizon_days} days)`} value={inr(moneyIn)} tone="pos" />
        <Tile label={`Money out (${forecast.horizon_days} days)`} value={inr(moneyOut)} />
        <Tile
          label="Lowest balance"
          value={inr(forecast.lowest.balance_inr)}
          note={shortDate(forecast.lowest.date)}
          tone={forecast.lowest.balance_inr < 0 ? 'neg' : undefined}
        />
        <Tile label="Safe to spend now" value={inr(forecast.safe_to_spend_inr)} tone={forecast.safe_to_spend_inr > 0 ? 'pos' : undefined} />
        <Tile label={`Balance on ${shortDate(points.at(-1)?.date ?? forecast.as_of)}`} value={inr(forecast.end_balance_inr)} />
      </div>

      <div className="pbi-slicers" role="group" aria-label="What if">
        <span className="pbi-slicer-label">Salary arrives</span>
        <div className="pbi-chips">
          {DELAYS.map((days) => (
            <button key={days} className={`pbi-chip ${delay === days ? 'on' : ''}`} aria-pressed={delay === days} onClick={() => setDelay(days)}>
              {days === 0 ? 'On time' : `${days} days late`}
            </button>
          ))}
        </div>
        {optional.length > 0 && (
          <>
            <span className="pbi-slicer-label">Include</span>
            <div className="pbi-chips">
              {optional.map((item) => {
                const included = !skip.includes(item.id);
                return (
                  <button
                    key={item.id}
                    className={`pbi-chip ${included ? 'on' : ''}`}
                    aria-pressed={included}
                    onClick={() => setSkip((current) => (included ? [...current, item.id] : current.filter((id) => id !== item.id)))}
                  >
                    {included && <Icon name="check" size={13} />}
                    {item.title} ({inr(item.amount_inr)})
                  </button>
                );
              })}
            </div>
          </>
        )}
      </div>

      <p className={forecast.crunch_inr > 0 ? 'alert alert-warn' : 'alert alert-info'}>{forecast.headline}</p>

      <div className="pbi-grid-layout">
        <div className="pbi-visual">
          <h4>Daily balance with money in and out</h4>
          <ComboChart forecast={forecast} points={points} />
        </div>
        <div className="pbi-visual">
          <h4>Biggest payments before payday</h4>
          {beforePayday.length ? <OutflowBars items={beforePayday} /> : <p className="muted small">Nothing is due before your salary arrives.</p>}
        </div>
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
