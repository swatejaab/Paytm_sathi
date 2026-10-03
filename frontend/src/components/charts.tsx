import { useEffect, useRef, useState, type ReactNode } from 'react';
import { inr, inrCompact } from '../format';

export const CHART_COLORS = ['var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)', 'var(--chart-5)', 'var(--chart-6)', 'var(--chart-7)'];

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
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

interface Tip {
  x: number;
  y: number;
  content: ReactNode;
}

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x, 70), Math.max(width - 70, 70));
  return (
    <div className="chart-tip" style={{ left, top: tip.y }} role="tooltip">
      {tip.content}
    </div>
  );
}

export function Legend({ items }: { items: { label: string; color: string; value?: string }[] }) {
  return (
    <ul className="legend">
      {items.map((item, index) => (
        <li key={`${item.label}-${index}`}>
          <span className="swatch" style={{ background: item.color }} />
          {item.label}
          {item.value && <strong>{item.value}</strong>}
        </li>
      ))}
    </ul>
  );
}

function niceMax(value: number): number {
  if (value <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((candidate) => candidate * magnitude >= value / 4)! * magnitude;
  return Math.ceil(value / step) * step;
}

function ticks(min: number, max: number, count = 4): number[] {
  const step = (max - min) / count;
  return Array.from({ length: count + 1 }, (_, index) => min + step * index);
}

const PAD = { top: 12, right: 12, bottom: 28, left: 56 };

export interface Series {
  key: string;
  label: string;
  color: string;
}

export function ColumnChart({ data, series, height = 240 }: { data: { label: string; values: Record<string, number> }[]; series: Series[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const max = niceMax(Math.max(...data.flatMap((row) => series.map((item) => row.values[item.key] ?? 0)), 0));
  const plotW = Math.max(width - PAD.left - PAD.right, 10);
  const plotH = height - PAD.top - PAD.bottom;
  const band = plotW / Math.max(data.length, 1);
  const barW = Math.min((band * 0.7) / series.length, 28);
  const y = (value: number) => PAD.top + plotH - (value / max) * plotH;

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Column chart: ${series.map((item) => item.label).join(' and ')} by month`}>
          {ticks(0, max).map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className="grid-line" />
              <text x={PAD.left - 8} y={y(tick) + 4} className="axis-label" textAnchor="end">
                {inrCompact(tick)}
              </text>
            </g>
          ))}
          {data.map((row, index) => {
            const groupX = PAD.left + band * index + (band - barW * series.length) / 2;
            const showTip = () =>
              setTip({
                x: PAD.left + band * index + band / 2,
                y: PAD.top,
                content: (
                  <>
                    <strong>{row.label}</strong>
                    {series.map((item) => (
                      <span key={item.key}>
                        <i style={{ background: item.color }} />
                        {item.label}: {inr(row.values[item.key] ?? 0)}
                      </span>
                    ))}
                  </>
                ),
              });
            return (
              <g key={`${row.label}-${index}`} onMouseMove={showTip} onClick={showTip}>
                <rect x={PAD.left + band * index} y={PAD.top} width={band} height={plotH} className="hover-band" />
                {series.map((item, seriesIndex) => {
                  const value = row.values[item.key] ?? 0;
                  return (
                    <rect
                      key={item.key}
                      x={groupX + seriesIndex * barW}
                      y={y(value)}
                      width={Math.max(barW - 3, 2)}
                      height={Math.max(PAD.top + plotH - y(value), 0)}
                      rx={3}
                      style={{ fill: item.color }}
                    />
                  );
                })}
                <text x={PAD.left + band * index + band / 2} y={height - 8} className="axis-label" textAnchor="middle">
                  {row.label}
                </text>
              </g>
            );
          })}
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
      <Legend items={series.map((item) => ({ label: item.label, color: item.color }))} />
    </div>
  );
}

export function LineChart({
  points,
  series,
  height = 240,
}: {
  points: { label: string; values: Record<string, number> }[];
  series: Series[];
  height?: number;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [tip, setTip] = useState<Tip | null>(null);
  const all = points.flatMap((point) => series.map((item) => point.values[item.key] ?? 0));
  const rawMin = Math.min(...all, 0);
  const max = niceMax(Math.max(...all, 1));
  const min = rawMin < 0 ? -niceMax(-rawMin) : 0;
  const plotW = Math.max(width - PAD.left - PAD.right, 10);
  const plotH = height - PAD.top - PAD.bottom;
  const x = (index: number) => PAD.left + (points.length <= 1 ? plotW / 2 : (plotW * index) / (points.length - 1));
  const y = (value: number) => PAD.top + plotH - ((value - min) / (max - min)) * plotH;
  const showPoint = (index: number) => {
    const point = points[index]!;
    setTip({
      x: x(index),
      y: PAD.top,
      content: (
        <>
          <strong>{point.label}</strong>
          {series.map((item) => (
            <span key={item.key}>
              <i style={{ background: item.color }} />
              {item.label}: {inr(point.values[item.key] ?? 0)}
            </span>
          ))}
        </>
      ),
    });
  };

  return (
    <div className="chart" ref={ref} onMouseLeave={() => setTip(null)}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Line chart: ${series.map((item) => item.label).join(' and ')}`}>
          {ticks(min, max).map((tick) => (
            <g key={tick}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} className={tick === 0 ? 'zero-line' : 'grid-line'} />
              <text x={PAD.left - 8} y={y(tick) + 4} className="axis-label" textAnchor="end">
                {inrCompact(tick)}
              </text>
            </g>
          ))}
          {series.map((item, seriesIndex) => {
            const path = points.map((point, index) => `${index ? 'L' : 'M'}${x(index)},${y(point.values[item.key] ?? 0)}`).join(' ');
            return (
              <g key={item.key}>
                {seriesIndex === 0 && points.length > 1 && (
                  <path d={`${path} L${x(points.length - 1)},${y(Math.max(min, 0))} L${x(0)},${y(Math.max(min, 0))} Z`} style={{ fill: item.color }} className="area" />
                )}
                <path d={path} style={{ stroke: item.color }} className="line" />
                {points.map((point, index) => (
                  <circle key={`${point.label}-${index}`} cx={x(index)} cy={y(point.values[item.key] ?? 0)} r={3.5} style={{ fill: item.color }} className="dot" />
                ))}
              </g>
            );
          })}
          {points.map((point, index) => (
            <g key={`${point.label}-${index}`}>
              <rect
                x={x(index) - plotW / Math.max(points.length, 1) / 2}
                y={PAD.top}
                width={plotW / Math.max(points.length, 1)}
                height={plotH}
                className="hover-band"
                onMouseMove={() => showPoint(index)}
                onClick={() => showPoint(index)}
              />
              {(points.length <= 8 || index % Math.ceil(points.length / 8) === 0) && (
                <text x={x(index)} y={height - 8} className="axis-label" textAnchor="middle">
                  {point.label}
                </text>
              )}
            </g>
          ))}
        </svg>
      )}
      <Tooltip tip={tip} width={width} />
      <Legend items={series.map((item) => ({ label: item.label, color: item.color }))} />
    </div>
  );
}

export function DonutChart({
  slices,
  centerLabel,
  ariaLabel = 'Spending by category',
}: {
  slices: { label: string; value: number }[];
  centerLabel: string;
  ariaLabel?: string;
}) {
  const [active, setActive] = useState<number | null>(null);
  const total = slices.reduce((sum, slice) => sum + slice.value, 0) || 1;
  const size = 200;
  const radius = 80;
  const stroke = 30;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const focus = active === null ? null : slices[active];
  return (
    <div className="donut">
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} role="img" aria-label={ariaLabel}>
        <circle cx={size / 2} cy={size / 2} r={radius} className="donut-track" strokeWidth={stroke} fill="none" />
        {slices.map((slice, index) => {
          const length = (slice.value / total) * circumference;
          const dash = `${Math.max(length - 2, 0)} ${circumference}`;
          const element = (
            <circle
              key={`${slice.label}-${index}`}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              strokeWidth={active === index ? stroke + 6 : stroke}
              strokeDasharray={dash}
              strokeDashoffset={-offset}
              style={{ stroke: CHART_COLORS[index % CHART_COLORS.length] }}
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
              onMouseEnter={() => setActive(index)}
              onMouseLeave={() => setActive(null)}
              onClick={() => setActive(active === index ? null : index)}
              className="donut-slice"
            >
              <title>{`${slice.label}: ${inr(slice.value)} (${Math.round((slice.value / total) * 100)}%)`}</title>
            </circle>
          );
          offset += length;
          return element;
        })}
        <text x={size / 2} y={size / 2 - 4} textAnchor="middle" className="donut-value">
          {focus ? inrCompact(focus.value) : inrCompact(total)}
        </text>
        <text x={size / 2} y={size / 2 + 16} textAnchor="middle" className="donut-label">
          {focus ? `${focus.label} · ${Math.round((focus.value / total) * 100)}%` : centerLabel}
        </text>
      </svg>
      <Legend
        items={slices.map((slice, index) => ({
          label: slice.label,
          color: CHART_COLORS[index % CHART_COLORS.length]!,
          value: inr(slice.value),
        }))}
      />
    </div>
  );
}

export function BarList({ rows, format = inr }: { rows: { label: string; value: number; secondary?: string; color?: string }[]; format?: (value: number) => string }) {
  const max = Math.max(...rows.map((row) => row.value), 1);
  return (
    <ul className="bar-list">
      {rows.map((row, index) => (
        <li key={`${row.label}-${index}`} title={`${row.label}: ${format(row.value)}`}>
          <div className="row space-between gap-sm">
            <span>{row.label}</span>
            <strong>{format(row.value)}</strong>
          </div>
          <div className="bar-track">
            <span style={{ width: `${(row.value / max) * 100}%`, background: row.color ?? CHART_COLORS[index % CHART_COLORS.length] }} />
          </div>
          {row.secondary && <small className="muted">{row.secondary}</small>}
        </li>
      ))}
    </ul>
  );
}

export function ProgressRing({ value, label }: { value: number; label: string }) {
  const radius = 34;
  const circumference = 2 * Math.PI * radius;
  const pct = Math.max(0, Math.min(value, 100));
  return (
    <svg viewBox="0 0 84 84" width={84} height={84} role="img" aria-label={`${label}: ${Math.round(pct)}%`} className="ring">
      <circle cx="42" cy="42" r={radius} className="ring-track" strokeWidth="8" fill="none" />
      <circle
        cx="42"
        cy="42"
        r={radius}
        className="ring-value"
        strokeWidth="8"
        fill="none"
        strokeLinecap="round"
        strokeDasharray={`${(pct / 100) * circumference} ${circumference}`}
        transform="rotate(-90 42 42)"
      />
      <text x="42" y="47" textAnchor="middle" className="ring-text">
        {Math.round(pct)}%
      </text>
    </svg>
  );
}
