'use client';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { formatDateRu, formatDateShortRu } from '@/domain/time';
import { cn } from '@/components/ui/cn';

/**
 * Small hand-rolled SVG charts (no chart library). Rules (PRD §7.4–7.5, §22.1, dataviz):
 * thin marks, hairline grid, one axis, hover + keyboard readout, a table twin, and days without
 * data drawn as visibly empty — never as zero, never coloured as success/failure.
 */

export interface ChartDay {
  date: string;
  weight: number | null;
  weightAvg7: number | null;
  steps: number | null;
}

const PLOT_H = 168;
const AXIS_H = 24;
const PAD_L = 44;
const PAD_R = 12;
const PAD_T = 12;

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.floor(e!.contentRect.width)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const n = raw / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * pow;
}

function ticks(min: number, max: number, target = 3): number[] {
  const step = niceStep(max - min || 1, target);
  const start = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = start; v <= max + 1e-9; v += step) out.push(Math.round(v * 100) / 100);
  return out;
}

const nf = new Intl.NumberFormat('ru-RU');

function xLabelIndexes(n: number): number[] {
  if (n <= 1) return [0];
  const step = Math.ceil(n / 5);
  const out: number[] = [];
  for (let i = n - 1; i >= 0; i -= step) out.unshift(i);
  return out;
}

/** Shared frame: sizing, x scale by day band, crosshair/tooltip, keyboard navigation. */
function ChartFrame({
  days,
  label,
  yTicks,
  yLabel,
  y,
  children,
  readout,
  dim,
}: {
  days: ChartDay[];
  label: string;
  yTicks: number[];
  yLabel: (v: number) => string;
  y: (v: number) => number;
  children: (geo: { x: (i: number) => number; band: number; width: number; active: number | null }) => ReactNode;
  readout: (d: ChartDay) => ReactNode;
  dim?: boolean;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [active, setActive] = useState<number | null>(null);
  const n = days.length;
  const plotW = Math.max(0, width - PAD_L - PAD_R);
  const band = n ? plotW / n : 0;
  const x = (i: number) => PAD_L + band * i + band / 2;

  function pick(e: PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left) / Math.max(1, band));
    setActive(Math.min(n - 1, Math.max(0, i)));
  }
  function onKey(e: KeyboardEvent<HTMLDivElement>) {
    if (!n) return;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      e.preventDefault();
      const d = e.key === 'ArrowLeft' ? -1 : 1;
      setActive((a) => Math.min(n - 1, Math.max(0, (a ?? n - 1) + (a === null ? 0 : d))));
    } else if (e.key === 'Escape') setActive(null);
  }
  const ad = active !== null ? days[active] : null;
  const tipLeft = active !== null ? Math.min(Math.max(x(active), 80), Math.max(80, width - 80)) : 0;

  return (
    <div
      ref={ref}
      className={cn('relative select-none outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-accent/40 rounded-xl', dim && 'opacity-50')}
      tabIndex={0}
      role="group"
      aria-label={`${label}. Стрелки влево и вправо — значения по дням.`}
      onKeyDown={onKey}
      onBlur={() => setActive(null)}
    >
      {width > 0 ? (
        <svg width={width} height={PAD_T + PLOT_H + AXIS_H} role="img" aria-label={label} className="block overflow-visible">
          {yTicks.map((t) => (
            <g key={t}>
              <line x1={PAD_L} x2={width - PAD_R} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} />
              <text x={PAD_L - 6} y={y(t)} dy="0.32em" textAnchor="end" className="tabular fill-[var(--muted)] text-[11px]">
                {yLabel(t)}
              </text>
            </g>
          ))}
          {xLabelIndexes(n).map((i) => (
            <text key={i} x={x(i)} y={PAD_T + PLOT_H + 16} textAnchor="middle" className="tabular fill-[var(--muted)] text-[11px]">
              {formatDateShortRu(days[i]!.date).split(' ')[1]}
            </text>
          ))}
          {active !== null ? <line x1={x(active)} x2={x(active)} y1={PAD_T} y2={PAD_T + PLOT_H} stroke="var(--faint)" strokeWidth={1} /> : null}
          {children({ x, band, width, active })}
          <rect
            x={PAD_L}
            y={PAD_T}
            width={plotW}
            height={PLOT_H}
            fill="transparent"
            onPointerMove={pick}
            onPointerDown={pick}
            onPointerLeave={(e) => e.pointerType === 'mouse' && setActive(null)}
          />
        </svg>
      ) : (
        <div style={{ height: PAD_T + PLOT_H + AXIS_H }} />
      )}
      {ad ? (
        <div
          role="status"
          className="pointer-events-none absolute top-0 z-10 min-w-36 -translate-x-1/2 rounded-xl border border-border bg-surface px-3 py-2 text-sm shadow-card"
          style={{ left: tipLeft }}
        >
          <div className="text-xs text-muted">{formatDateRu(ad.date)}</div>
          {readout(ad)}
        </div>
      ) : null}
    </div>
  );
}

export function WeightChart({ days, dim }: { days: ChartDay[]; dim?: boolean }) {
  const values = days.flatMap((d) => [d.weight, d.weightAvg7]).filter((v): v is number => v !== null);
  const lo = Math.floor((Math.min(...values) - 0.3) * 2) / 2;
  const hi = Math.ceil((Math.max(...values) + 0.3) * 2) / 2;
  const yT = ticks(lo, hi, 3);
  const y = (v: number) => PAD_T + PLOT_H - ((v - lo) / (hi - lo || 1)) * PLOT_H;
  const lastIdx = days.map((d) => d.weight !== null).lastIndexOf(true);

  return (
    <ChartFrame
      days={days}
      dim={dim}
      label="Вес по дням и средняя за 7 дней"
      yTicks={yT}
      yLabel={(v) => nf.format(v)}
      y={y}
      readout={(d) => (
        <div className="mt-0.5 space-y-0.5">
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="size-2 rounded-full bg-[var(--muted)]" />
            <span className="tabular font-semibold">{d.weight !== null ? `${nf.format(d.weight)} кг` : 'нет замера'}</span>
          </div>
          <div className="flex items-center gap-2">
            <span aria-hidden="true" className="h-0.5 w-3 rounded bg-accent" />
            <span className="tabular">{d.weightAvg7 !== null ? `${nf.format(d.weightAvg7)} кг` : 'мало данных'}</span>
            <span className="text-xs text-muted">средняя</span>
          </div>
        </div>
      )}
    >
      {({ x, active }) => {
        // trend line, broken where the window has too few points
        const segs: string[] = [];
        let cur = '';
        days.forEach((d, i) => {
          if (d.weightAvg7 === null) {
            if (cur) segs.push(cur);
            cur = '';
          } else cur += `${cur ? 'L' : 'M'}${x(i).toFixed(1)},${y(d.weightAvg7).toFixed(1)}`;
        });
        if (cur) segs.push(cur);
        return (
          <g>
            {segs.map((p, i) => (
              <path key={i} d={p} fill="none" stroke="var(--accent)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
            ))}
            {days.map((d, i) =>
              d.weight !== null ? (
                <circle key={d.date} cx={x(i)} cy={y(d.weight)} r={active === i ? 5 : 4} fill="var(--muted)" stroke="var(--surface)" strokeWidth={2} />
              ) : null,
            )}
            {lastIdx >= 0 ? (
              <text x={Math.min(x(lastIdx), x(days.length - 1))} y={y(days[lastIdx]!.weight!) - 10} textAnchor="end" className="tabular fill-[var(--text)] text-[12px] font-medium">
                {nf.format(days[lastIdx]!.weight!)}
              </text>
            ) : null}
          </g>
        );
      }}
    </ChartFrame>
  );
}

function compactSteps(v: number, compact: boolean): string {
  if (!compact) return nf.format(v);
  return v === 0 ? '0' : `${nf.format(Math.round((v / 1000) * 10) / 10)} тыс`;
}

export function StepsChart({ days, dim }: { days: ChartDay[]; dim?: boolean }) {
  const max = Math.max(1000, ...days.map((d) => d.steps ?? 0));
  const yT = ticks(0, max, 3);
  const top = Math.max(max, yT.at(-1) ?? max);
  const compact = top >= 10000;
  const y = (v: number) => PAD_T + PLOT_H - (v / top) * PLOT_H;
  const base = PAD_T + PLOT_H;

  return (
    <ChartFrame
      days={days}
      dim={dim}
      label="Шаги по дням"
      yTicks={yT}
      yLabel={(v) => compactSteps(v, compact)}
      y={y}
      readout={(d) => <div className="tabular mt-0.5 font-semibold">{d.steps !== null ? `${nf.format(d.steps)} шагов` : 'нет данных'}</div>}
    >
      {({ x, band, active }) => {
        const w = Math.max(1, Math.min(24, band - 2));
        return (
          <g>
            {days.map((d, i) => {
              if (d.steps === null) {
                // unknown: a hollow marker on the baseline — visibly empty, not a zero bar
                return <circle key={d.date} cx={x(i)} cy={base - 4} r={Math.min(3, Math.max(1.5, w / 2 - 0.5))} fill="none" stroke="var(--faint)" strokeWidth={1.5} />;
              }
              const h = Math.max(2, base - y(d.steps));
              const r = Math.min(4, w / 2, h);
              const x0 = x(i) - w / 2;
              const top0 = base - h;
              return (
                <path
                  key={d.date}
                  d={`M${x0},${base}V${top0 + r}Q${x0},${top0} ${x0 + r},${top0}H${x0 + w - r}Q${x0 + w},${top0} ${x0 + w},${top0 + r}V${base}Z`}
                  fill="var(--accent)"
                  opacity={active === null || active === i ? 1 : 0.55}
                />
              );
            })}
          </g>
        );
      }}
    </ChartFrame>
  );
}

export function ChartTable({ days, metric }: { days: ChartDay[]; metric: 'weight' | 'steps' }) {
  return (
    <details className="group mt-2">
      <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm text-accent">Показать таблицей</summary>
      <div className="max-h-72 overflow-y-auto rounded-xl border border-border">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-surface-2 text-left text-xs text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">День</th>
              <th className="px-3 py-2 text-right font-medium">{metric === 'weight' ? 'Вес, кг' : 'Шаги'}</th>
              {metric === 'weight' ? <th className="px-3 py-2 text-right font-medium">Средняя 7 дн.</th> : null}
            </tr>
          </thead>
          <tbody className="tabular divide-y divide-border">
            {[...days].reverse().map((d) => {
              const v = metric === 'weight' ? d.weight : d.steps;
              return (
                <tr key={d.date}>
                  <td className="px-3 py-1.5">{formatDateShortRu(d.date)}</td>
                  <td className={cn('px-3 py-1.5 text-right', v === null && 'text-faint')}>{v === null ? 'нет данных' : nf.format(v)}</td>
                  {metric === 'weight' ? <td className={cn('px-3 py-1.5 text-right', d.weightAvg7 === null && 'text-faint')}>{d.weightAvg7 === null ? '—' : nf.format(d.weightAvg7)}</td> : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}
