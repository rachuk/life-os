import { addDays, daysBetween, type LocalDate } from '../time';

/**
 * «Изменение привычек» (reduce → maybe quit). Pure logic, no IO.
 * Principles (owner + PRD add-on): no shame, no streak resets — a slip is data; first a baseline week
 * of honest observation, then a gradual limit; patterns explain *when*, not *who is guilty*.
 */

export type HabitEventKind = 'use' | 'urge_resisted' | 'day_total';
export type HabitPhase = 'baseline' | 'reducing' | 'quit' | 'paused';

export interface HabitEvent {
  kind: HabitEventKind;
  localDate: LocalDate;
  localHour: number; // 0..23 in the user's zone
  quantity: number;
  reason: string | null;
  duringExtraWork?: boolean;
  duringWork?: boolean;
}

export const DEFAULT_REASONS = ['После кофе', 'Рабочий стресс', 'Перерыв на работе', 'После еды', 'Скука', 'По привычке', 'В компании', 'За рулём / в дороге'];
export const DEFAULT_ALTERNATIVES = ['Стакан воды', '5 минут пройтись', '3 медленных вдоха', 'Перекус', 'Отложить на 10 минут'];

export interface DaySummary {
  date: LocalDate;
  /** null = no data for that day ("нет данных" ≠ 0) */
  total: number | null;
  /** explicit end-of-day total entered by the user (overrides per-use sum) */
  fromDayTotal: boolean;
  resisted: number;
}

export function summarizeDays(events: HabitEvent[], from: LocalDate, to: LocalDate): DaySummary[] {
  const out: DaySummary[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const day = events.filter((e) => e.localDate === d);
    const dayTotal = day.find((e) => e.kind === 'day_total');
    const uses = day.filter((e) => e.kind === 'use').reduce((s, e) => s + e.quantity, 0);
    const resisted = day.filter((e) => e.kind === 'urge_resisted').length;
    const hasUses = day.some((e) => e.kind === 'use');
    out.push({
      date: d,
      total: dayTotal ? dayTotal.quantity : hasUses ? uses : null,
      fromDayTotal: !!dayTotal,
      resisted,
    });
  }
  return out;
}

export function average(values: (number | null)[]): number | null {
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return null;
  return Math.round((known.reduce((a, b) => a + b, 0) / known.length) * 10) / 10;
}

export interface BaselineStatus {
  daysElapsed: number;
  daysWithData: number;
  needed: number;
  ready: boolean;
  perDay: number | null;
}

/** Baseline needs at least 3 days with data inside the observation window (default 7 days). */
export function baselineStatus(days: DaySummary[], startedOn: LocalDate, today: LocalDate, baselineDays: number): BaselineStatus {
  const windowEnd = addDays(startedOn, baselineDays - 1);
  const inWindow = days.filter((d) => d.date >= startedOn && d.date <= windowEnd && d.date <= today);
  const daysWithData = inWindow.filter((d) => d.total !== null).length;
  const daysElapsed = Math.min(baselineDays, Math.max(0, daysBetween(startedOn, today) + 1));
  return {
    daysElapsed,
    daysWithData,
    needed: baselineDays,
    ready: daysElapsed >= baselineDays && daysWithData >= 3,
    perDay: average(inWindow.map((d) => d.total)),
  };
}

/**
 * Gradual plan: start one step below the baseline, then −step each week, never below 0.
 * The limit is a suggestion the user confirms; it never drops automatically without consent
 * beyond the agreed weekly step.
 */
export function suggestedStartLimit(baselinePerDay: number, step: number): number {
  return Math.max(0, Math.ceil(baselinePerDay) - Math.max(1, step));
}

export function scheduledLimit(startLimit: number, limitSetOn: LocalDate, today: LocalDate, stepPerWeek: number): number {
  const weeks = Math.max(0, Math.floor(daysBetween(limitSetOn, today) / 7));
  return Math.max(0, startLimit - weeks * stepPerWeek);
}

export type DayStatus = 'within' | 'over' | 'unknown';
export function dayStatus(total: number | null, limit: number | null): DayStatus {
  if (total === null || limit === null) return 'unknown';
  return total <= limit ? 'within' : 'over';
}

export interface Savings {
  units: number;
  cents: number | null;
  daysCounted: number;
}

/** Units not used compared to the baseline, over days with data only. */
export function savings(days: DaySummary[], baselinePerDay: number | null, pricePerUnitCents: number | null): Savings {
  if (baselinePerDay === null) return { units: 0, cents: pricePerUnitCents === null ? null : 0, daysCounted: 0 };
  const known = days.filter((d) => d.total !== null);
  const units = Math.max(0, Math.round(known.reduce((s, d) => s + Math.max(0, baselinePerDay - (d.total ?? 0)), 0)));
  return { units, cents: pricePerUnitCents === null ? null : units * pricePerUnitCents, daysCounted: known.length };
}

export interface HabitPattern {
  key: string;
  text: string;
  basedOn: string;
}

const PART_OF_DAY: [string, number, number][] = [
  ['утром', 5, 11],
  ['днём', 12, 17],
  ['вечером', 18, 22],
  ['ночью', 23, 4],
];

function partOfDay(h: number): string {
  for (const [name, a, b] of PART_OF_DAY) {
    if (a <= b ? h >= a && h <= b : h >= a || h <= b) return name;
  }
  return 'днём';
}

/**
 * Careful, non-causal observations (≥ a few data points each). Words like «чаще», «в среднем»,
 * never «из-за».
 */
export function detectHabitPatterns(events: HabitEvent[], days: DaySummary[], extraWorkDates: Set<LocalDate>, unit: string): HabitPattern[] {
  const out: HabitPattern[] = [];
  const uses = events.filter((e) => e.kind === 'use');
  const totalUses = uses.reduce((s, e) => s + e.quantity, 0);
  if (totalUses >= 5) {
    const byReason = new Map<string, number>();
    for (const e of uses) if (e.reason) byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + e.quantity);
    const top = [...byReason.entries()].sort((a, b) => b[1] - a[1])[0];
    const withReason = [...byReason.values()].reduce((a, b) => a + b, 0);
    if (top && top[1] >= 3 && withReason >= 5) {
      out.push({
        key: 'top_reason',
        text: `Чаще всего — «${top[0]}»: ${top[1]} из ${withReason} отметок с причиной.`,
        basedOn: `${withReason} отметок с указанной причиной`,
      });
    }
    const byPart = new Map<string, number>();
    for (const e of uses) byPart.set(partOfDay(e.localHour), (byPart.get(partOfDay(e.localHour)) ?? 0) + e.quantity);
    const topPart = [...byPart.entries()].sort((a, b) => b[1] - a[1])[0];
    if (topPart && topPart[1] / totalUses >= 0.45) {
      out.push({
        key: 'part_of_day',
        text: `Больше всего ${unit} — ${topPart[0]} (${Math.round((topPart[1] / totalUses) * 100)}%).`,
        basedOn: `${totalUses} отметок по времени`,
      });
    }
    const workUses = uses.filter((e) => e.duringWork).reduce((s, e) => s + e.quantity, 0);
    if (workUses / totalUses >= 0.5 && workUses >= 4) {
      out.push({
        key: 'during_work',
        text: `${Math.round((workUses / totalUses) * 100)}% — в рабочие часы. Возможно, помогут другие короткие перерывы (вода, пройтись).`,
        basedOn: `${workUses} из ${totalUses} отметок в рабочем блоке`,
      });
    }
  }
  const known = days.filter((d) => d.total !== null);
  const xw = known.filter((d) => extraWorkDates.has(d.date));
  const normal = known.filter((d) => !extraWorkDates.has(d.date));
  if (xw.length >= 2 && normal.length >= 2) {
    const a = average(xw.map((d) => d.total))!;
    const b = average(normal.map((d) => d.total))!;
    if (a - b >= 1.5) {
      out.push({
        key: 'extra_work',
        text: `В дни с переработкой в среднем ${a} против ${b} в обычные дни.`,
        basedOn: `${xw.length} дн. с переработкой и ${normal.length} обычных`,
      });
    }
  }
  return out.slice(0, 3);
}

export interface WeekProgress {
  days: { date: LocalDate; total: number | null; limit: number | null; status: DayStatus }[];
  withinLimit: number;
  overLimit: number;
  unknown: number;
  average: number | null;
}

export function weekProgress(days: DaySummary[], limitFor: (date: LocalDate) => number | null): WeekProgress {
  const rows = days.map((d) => {
    const limit = limitFor(d.date);
    return { date: d.date, total: d.total, limit, status: dayStatus(d.total, limit) };
  });
  return {
    days: rows,
    withinLimit: rows.filter((r) => r.status === 'within').length,
    overLimit: rows.filter((r) => r.status === 'over').length,
    unknown: rows.filter((r) => r.total === null).length,
    average: average(days.map((d) => d.total)),
  };
}
