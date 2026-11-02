import type { DateTime } from 'luxon';
import { minutesToTime, timeToMinutes, zoned, type LocalDate, type LocalTime } from '../time';
import type { Slot } from './model';

export interface BusyInterval {
  startAt: DateTime;
  endAt: DateTime;
  /** optional tag to explain conflicts */
  label?: string;
}

export function overlapsAny(start: DateTime, end: DateTime, busy: BusyInterval[]): BusyInterval | null {
  for (const b of busy) {
    if (start < b.endAt && b.startAt < end) return b;
  }
  return null;
}

export interface FindSlotOptions {
  date: LocalDate;
  tz: string;
  durationMinutes: number;
  earliest: LocalTime;
  latest: LocalTime; // the event must END by this local time
  preferredStart?: LocalTime;
  busy: BusyInterval[];
  paddingBeforeMinutes?: number;
  paddingAfterMinutes?: number;
  notBefore?: DateTime;
  stepMinutes?: number;
}

/**
 * Deterministic slot search: candidate starts on a fixed grid inside [earliest, latest − duration],
 * ordered by distance to the preferred start (earlier wins ties). Padding (e.g. travel time)
 * must also be free. Returns null when nothing fits — the caller reports a conflict.
 */
export function findSlot(o: FindSlotOptions): Slot | null {
  const step = o.stepMinutes ?? 15;
  const earliest = timeToMinutes(o.earliest);
  let latestEnd = timeToMinutes(o.latest);
  if (latestEnd <= earliest) latestEnd += 24 * 60; // window crossing midnight is not supported beyond 24h
  const preferred = o.preferredStart ? timeToMinutes(o.preferredStart) : earliest;
  const padB = o.paddingBeforeMinutes ?? 0;
  const padA = o.paddingAfterMinutes ?? 0;

  const candidates: number[] = [];
  for (let m = earliest; m + o.durationMinutes <= latestEnd; m += step) candidates.push(m);
  if (preferred >= earliest && preferred + o.durationMinutes <= latestEnd && !candidates.includes(preferred)) {
    candidates.push(preferred);
  }
  candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred) || a - b);

  for (const m of candidates) {
    if (m >= 24 * 60) continue;
    const startAt = zoned(o.date, minutesToTime(m), o.tz);
    const endAt = startAt.plus({ minutes: o.durationMinutes });
    if (o.notBefore && startAt.minus({ minutes: padB }) < o.notBefore) continue;
    const hit = overlapsAny(startAt.minus({ minutes: padB }), endAt.plus({ minutes: padA }), o.busy);
    if (!hit) return { startAt, endAt };
  }
  return null;
}

/** Free gaps inside [from, to] given busy intervals (sorted, merged). */
export function freeGaps(from: DateTime, to: DateTime, busy: BusyInterval[], minMinutes = 15): Slot[] {
  const sorted = busy
    .filter((b) => b.endAt > from && b.startAt < to)
    .map((b) => ({ startAt: b.startAt < from ? from : b.startAt, endAt: b.endAt > to ? to : b.endAt }))
    .sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
  const gaps: Slot[] = [];
  let cursor = from;
  for (const b of sorted) {
    if (b.startAt > cursor && b.startAt.diff(cursor, 'minutes').minutes >= minMinutes) {
      gaps.push({ startAt: cursor, endAt: b.startAt });
    }
    if (b.endAt > cursor) cursor = b.endAt;
  }
  if (to > cursor && to.diff(cursor, 'minutes').minutes >= minMinutes) gaps.push({ startAt: cursor, endAt: to });
  return gaps;
}
