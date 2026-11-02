import { DateTime, Interval } from 'luxon';

/**
 * Time rules (PRD §5.7, §15.5):
 * - instants are stored in UTC (timestamptz) and handled as luxon DateTime;
 * - a "local date" is the user's calendar day in their IANA zone, as 'YYYY-MM-DD';
 * - local wall-clock times are 'HH:mm' strings interpreted in the zone for a given local date,
 *   so 09:00 stays 09:00 across DST transitions.
 * Never derive a local date with toISOString().slice(0, 10).
 */

export type LocalDate = string; // 'YYYY-MM-DD'
export type LocalTime = string; // 'HH:mm'

export const DEFAULT_TZ = 'Europe/Lisbon';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isLocalDate(v: string): boolean {
  return DATE_RE.test(v) && DateTime.fromISO(v).isValid;
}

export function isLocalTime(v: string): boolean {
  return TIME_RE.test(v);
}

export function isValidZone(tz: string): boolean {
  return DateTime.local().setZone(tz).isValid;
}

export function toDateTime(v: Date | string | DateTime): DateTime {
  if (DateTime.isDateTime(v)) return v.toUTC();
  if (v instanceof Date) return DateTime.fromJSDate(v, { zone: 'utc' });
  return DateTime.fromISO(v, { zone: 'utc' });
}

/** Local calendar date of an instant in the given zone. */
export function localDateOf(instant: Date | string | DateTime, tz: string): LocalDate {
  return toDateTime(instant).setZone(tz).toISODate()!;
}

/** Local wall-clock time 'HH:mm' of an instant in the given zone. */
export function localTimeOf(instant: Date | string | DateTime, tz: string): LocalTime {
  return toDateTime(instant).setZone(tz).toFormat('HH:mm');
}

/** Normalise 'HH:mm:ss' (postgres time) or 'H:mm' to 'HH:mm'. */
export function normTime(v: string): LocalTime {
  const [h = '0', m = '0'] = v.split(':');
  return `${h.padStart(2, '0')}:${m.padStart(2, '0')}`;
}

export function timeToMinutes(t: LocalTime): number {
  const [h, m] = normTime(t).split(':').map(Number) as [number, number];
  return h * 60 + m;
}

export function minutesToTime(total: number): LocalTime {
  const m = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * The instant at which local wall-clock `time` happens on `date` in `tz`.
 * For a non-existent local time (spring-forward gap) luxon moves forward by the gap,
 * for an ambiguous time (fall-back) it picks the earlier offset — both deterministic.
 */
export function zoned(date: LocalDate, time: LocalTime, tz: string): DateTime {
  const [h, m] = normTime(time).split(':').map(Number) as [number, number];
  const d = DateTime.fromISO(date, { zone: tz }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
  if (!d.isValid) throw new Error(`Invalid local datetime ${date} ${time} in ${tz}`);
  return d.toUTC();
}

export function addDays(date: LocalDate, days: number): LocalDate {
  return DateTime.fromISO(date, { zone: 'utc' }).plus({ days }).toISODate()!;
}

/** ISO weekday 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: LocalDate): number {
  return DateTime.fromISO(date, { zone: 'utc' }).weekday;
}

/** Monday of the local week containing `date` (PRD: weeks are Mon–Sun). */
export function weekStartOf(date: LocalDate): LocalDate {
  return addDays(date, 1 - isoWeekday(date));
}

export function weekDates(weekStart: LocalDate): LocalDate[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function compareDates(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function daysBetween(a: LocalDate, b: LocalDate): number {
  return Math.round(DateTime.fromISO(b, { zone: 'utc' }).diff(DateTime.fromISO(a, { zone: 'utc' }), 'days').days);
}

/** UTC bounds [start, end) of a local week, for SQL range filters. */
export function weekBoundsUtc(weekStart: LocalDate, tz: string): { start: DateTime; end: DateTime } {
  return { start: zoned(weekStart, '00:00', tz), end: zoned(addDays(weekStart, 7), '00:00', tz) };
}

export function dayBoundsUtc(date: LocalDate, tz: string): { start: DateTime; end: DateTime } {
  return { start: zoned(date, '00:00', tz), end: zoned(addDays(date, 1), '00:00', tz) };
}

export function overlaps(aStart: DateTime, aEnd: DateTime, bStart: DateTime, bEnd: DateTime): boolean {
  return aStart < bEnd && bStart < aEnd;
}

export function minutesBetween(a: DateTime, b: DateTime): number {
  return Math.round(b.diff(a, 'minutes').minutes);
}

export function roundUpToStep(dt: DateTime, stepMinutes: number): DateTime {
  const ms = stepMinutes * 60_000;
  const t = dt.toMillis();
  return DateTime.fromMillis(Math.ceil(t / ms) * ms, { zone: 'utc' });
}

export function intervalOf(start: DateTime, end: DateTime): Interval {
  return Interval.fromDateTimes(start, end);
}

// ---------------------------------------------------------------------------
// Russian formatting (24h clock, weekday always shown — PRD §2.3)
// ---------------------------------------------------------------------------
const WEEKDAYS_SHORT = ['', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const WEEKDAYS_LONG = ['', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота', 'воскресенье'];
const MONTHS_GEN = ['', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export function weekdayShort(isoDay: number): string {
  return WEEKDAYS_SHORT[isoDay] ?? '';
}

export function weekdayLong(isoDay: number): string {
  return WEEKDAYS_LONG[isoDay] ?? '';
}

/** 'Пн, 2 ноября' */
export function formatDateRu(date: LocalDate, opts: { long?: boolean; year?: boolean } = {}): string {
  const d = DateTime.fromISO(date, { zone: 'utc' });
  const wd = opts.long ? weekdayLong(d.weekday) : weekdayShort(d.weekday);
  const base = `${wd}, ${d.day} ${MONTHS_GEN[d.month]}`;
  return opts.year ? `${base} ${d.year}` : base;
}

/** '02.11 (Пн)' compact form for lists */
export function formatDateShortRu(date: LocalDate): string {
  const d = DateTime.fromISO(date, { zone: 'utc' });
  return `${weekdayShort(d.weekday)} ${d.toFormat('dd.MM')}`;
}

export function formatTime(instant: Date | string | DateTime, tz: string): LocalTime {
  return localTimeOf(instant, tz);
}

export function formatRange(start: Date | string | DateTime, end: Date | string | DateTime, tz: string): string {
  return `${formatTime(start, tz)}–${formatTime(end, tz)}`;
}

export function formatDuration(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} ч ${m} мин`;
  if (h) return `${h} ч`;
  return `${m} мин`;
}

export function relativeDayLabel(date: LocalDate, today: LocalDate): string {
  const diff = daysBetween(today, date);
  if (diff === 0) return 'Сегодня';
  if (diff === 1) return 'Завтра';
  if (diff === -1) return 'Вчера';
  return formatDateRu(date);
}
