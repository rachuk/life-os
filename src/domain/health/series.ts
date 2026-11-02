import { addDays, daysBetween, type LocalDate } from '../time';

/**
 * Health series rules (PRD §7.4–7.5, §20.1, HEALTH-05):
 *  - every calendar day in a range is present; a day without a measurement is `null`, never 0;
 *  - the weight trend is a trailing 7-day mean that is shown only when the window holds enough
 *    observations — a single weigh-in is not a trend and is never judged as success/failure.
 */

export interface DayValue {
  date: LocalDate;
  value: number | null;
}

/** Fill a sparse map into a dense day-by-day series with explicit nulls. */
export function denseSeries(from: LocalDate, to: LocalDate, values: Map<LocalDate, number>): DayValue[] {
  const out: DayValue[] = [];
  if (from > to) return out;
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, value: values.has(d) ? values.get(d)! : null });
  return out;
}

export const TREND_WINDOW_DAYS = 7;
export const TREND_MIN_POINTS = 3;

/**
 * Trailing moving average over calendar days (not over observations): for day D the window is
 * [D-6, D]. Returns null when fewer than `minPoints` real values fall into the window.
 * `history` may contain values before the first day of `series` so the first days get a full window.
 */
export function trailingAverage(
  series: DayValue[],
  history: DayValue[] = [],
  windowDays = TREND_WINDOW_DAYS,
  minPoints = TREND_MIN_POINTS,
): (number | null)[] {
  const known = [...history, ...series].filter((p): p is { date: LocalDate; value: number } => p.value !== null);
  return series.map((p) => {
    const start = addDays(p.date, -(windowDays - 1));
    const inWindow = known.filter((k) => k.date >= start && k.date <= p.date);
    if (inWindow.length < minPoints) return null;
    const mean = inWindow.reduce((s, k) => s + k.value, 0) / inWindow.length;
    return Math.round(mean * 10) / 10;
  });
}

export interface StepsStats {
  knownDays: number;
  unknownDays: number;
  /** Mean over days with data only; null when there is no data at all. */
  averageKnown: number | null;
}

export function stepsStats(series: DayValue[]): StepsStats {
  const known = series.filter((p) => p.value !== null) as { date: LocalDate; value: number }[];
  return {
    knownDays: known.length,
    unknownDays: series.length - known.length,
    averageKnown: known.length ? Math.round(known.reduce((s, p) => s + p.value, 0) / known.length) : null,
  };
}

export interface WeightStats {
  count: number;
  latest: { date: LocalDate; value: number } | null;
  /** Latest available trend value (null if never enough points). */
  latestTrend: number | null;
}

export function weightStats(series: DayValue[], trend: (number | null)[]): WeightStats {
  const known = series.filter((p) => p.value !== null) as { date: LocalDate; value: number }[];
  let latestTrend: number | null = null;
  for (let i = trend.length - 1; i >= 0; i--) {
    if (trend[i] !== null) {
      latestTrend = trend[i]!;
      break;
    }
  }
  return { count: known.length, latest: known.at(-1) ?? null, latestTrend };
}

/** Clamp a requested range to at most `maxDays` days ending at `to`. */
export function clampRange(from: LocalDate, to: LocalDate, maxDays = 366): { from: LocalDate; to: LocalDate } {
  if (from > to) return { from: to, to };
  if (daysBetween(from, to) + 1 > maxDays) return { from: addDays(to, -(maxDays - 1)), to };
  return { from, to };
}

/** Hours with one decimal ↔ minutes for sleep input. */
export function hoursToMinutes(hours: number): number {
  return Math.round(hours * 60);
}

export function minutesToHoursLabel(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} ч ${m} мин` : `${h} ч`;
}

export const SLEEP_QUALITY_LABELS: Record<number, string> = { 1: 'плохо', 2: 'нормально', 3: 'хорошо' };
