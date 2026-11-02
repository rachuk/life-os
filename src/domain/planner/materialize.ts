import type { DateTime } from 'luxon';
import {
  addDays,
  dayBoundsUtc,
  isoWeekday,
  timeToMinutes,
  weekStartOf,
  zoned,
  type LocalDate,
  type LocalTime,
} from '../time';
import type { NewEvent, PlanEvent } from './model';
import { occupiesTime } from './model';
import type { TemplateSpec } from './prefs';
import { findSlot, type BusyInterval } from './slots';

export interface MaterializeInput {
  templates: TemplateSpec[];
  tz: string;
  fromDate: LocalDate;
  toDate: LocalDate; // inclusive
  now: DateTime;
  existing: PlanEvent[]; // all events overlapping the range (any status), incl. origin keys
  gymTravelMinutes?: number | null;
  /** origin keys that exist outside the loaded range (moved instances) */
  extraOriginKeys?: string[];
}

export interface PlacementRisk {
  templateId: string;
  templateKey: string;
  title: string;
  weekStart: LocalDate;
  missing: number;
  message: string;
}

export interface MaterializeResult {
  events: NewEvent[];
  risks: PlacementRisk[];
}

type Busyish = { startAt: DateTime; endAt: DateTime; label?: string };

export function templateOriginKey(templateId: string, date: LocalDate): string {
  return `tpl:${templateId}:${date}`;
}

export function quotaOriginKey(templateId: string, weekStart: LocalDate, n: number): string {
  return `quota:${templateId}:${weekStart}:${n}`;
}

function datesInRange(from: LocalDate, to: LocalDate): LocalDate[] {
  const out: LocalDate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Instance times for a weekly template on a given date (sleep spans to the next morning). */
export function weeklyInstance(
  tpl: TemplateSpec,
  date: LocalDate,
  tz: string,
  templates: TemplateSpec[],
): { startAt: DateTime; endAt: DateTime } | null {
  if (!tpl.localStart) return null;
  if (tpl.kind === 'sleep') {
    const bed = tpl.localStart;
    const startDate = timeToMinutes(bed) >= 12 * 60 ? date : addDays(date, 1);
    const next = addDays(date, 1);
    const nextMorning = templates.find(
      (t) =>
        t.enabled &&
        t.kind === 'morning_routine' &&
        t.recurrence.type === 'weekly' &&
        t.recurrence.days.includes(isoWeekday(next)),
    );
    const wake: LocalTime = nextMorning?.localStart ?? tpl.localEnd ?? '08:00';
    const startAt = zoned(startDate, bed, tz);
    const endAt = zoned(next, wake, tz);
    return endAt > startAt ? { startAt, endAt } : null;
  }
  const startAt = zoned(date, tpl.localStart, tz);
  const endAt = tpl.localEnd ? zoned(date, tpl.localEnd, tz) : startAt.plus({ minutes: tpl.durationMinutes });
  if (endAt <= startAt) return null;
  return { startAt, endAt };
}

/** Spread k picks over n ordered items (deterministic, centred). */
export function spreadIndices(n: number, k: number): number[] {
  if (k <= 0 || n <= 0) return [];
  if (k >= n) return Array.from({ length: n }, (_, i) => i);
  const out: number[] = [];
  for (let i = 0; i < k; i++) out.push(Math.floor(((i + 0.5) * n) / k));
  return [...new Set(out)];
}

/**
 * Deterministic core (PRD §5.3): instantiate weekly templates for each date ≥ today,
 * then place weekly quotas (workouts, own projects) into free slots near the preferred time.
 * Idempotent through origin keys: an already materialised instance is never duplicated,
 * and an instance the user moved/cancelled is not recreated.
 */
export function materializeRange(input: MaterializeInput): MaterializeResult {
  const { templates, tz, now } = input;
  const today = now.setZone(tz).toISODate()!;
  const from = input.fromDate < today ? today : input.fromDate;
  const existingKeys = new Set([
    ...(input.existing.map((e) => e.originKey).filter(Boolean) as string[]),
    ...(input.extraOriginKeys ?? []),
  ]);
  const created: NewEvent[] = [];
  const risks: PlacementRisk[] = [];
  if (from > input.toDate) return { events: created, risks };

  const dates = datesInRange(from, input.toDate);

  // 1) weekly templates (fixed, protected, flexible)
  for (const tpl of templates) {
    if (!tpl.enabled || tpl.recurrence.type !== 'weekly') continue;
    // the night that started yesterday (bed time after midnight) still matters today
    const tplDates = tpl.kind === 'sleep' ? [addDays(from, -1), ...dates] : dates;
    for (const date of tplDates) {
      if (!tpl.recurrence.days.includes(isoWeekday(date))) continue;
      const key = templateOriginKey(tpl.id, date);
      if (existingKeys.has(key)) continue;
      const inst = weeklyInstance(tpl, date, tz, templates);
      if (!inst || inst.endAt <= now) continue;
      created.push({
        kind: tpl.kind,
        title: tpl.title,
        priorityClass: tpl.priorityClass,
        localDate: date,
        startAt: inst.startAt,
        endAt: inst.endAt,
        templateId: tpl.id,
        flexWindow: tpl.flexWindow,
        originKey: key,
        source: 'template',
      });
      existingKeys.add(key);
    }
  }

  // 2) weekly quotas, per week touched by the range
  const weeks = [...new Set(dates.map(weekStartOf))];
  const quotaTemplates = templates
    .filter((t) => t.enabled && t.recurrence.type === 'weekly_quota')
    .sort((a, b) => a.sortOrder - b.sortOrder);

  for (const week of weeks) {
    for (const tpl of quotaTemplates) {
      if (tpl.recurrence.type !== 'weekly_quota') continue;
      const rec = tpl.recurrence;
      const missingNs: number[] = [];
      for (let n = 1; n <= rec.count; n++) {
        if (!existingKeys.has(quotaOriginKey(tpl.id, week, n))) missingNs.push(n);
      }
      if (!missingNs.length) continue;

      const weekDays = Array.from({ length: 7 }, (_, i) => addDays(week, i)).filter(
        (d) => d >= from && d <= input.toDate && rec.allowedDays.includes(isoWeekday(d)),
      );
      const usedDays = new Set<LocalDate>(
        [...input.existing.filter((e) => occupiesTime(e)), ...created]
          .filter((e) => e.templateId === tpl.id && weekStartOf(e.localDate) === week)
          .map((e) => e.localDate),
      );

      const placeOn = (date: LocalDate): { startAt: DateTime; endAt: DateTime } | null => {
        const busy = busyForDay(date, tz, input.existing, created);
        const isWeekend = !templates.some(
          (t) => t.kind === 'work' && t.enabled && t.recurrence.type === 'weekly' && t.recurrence.days.includes(isoWeekday(date)),
        );
        const earliest = isWeekend && rec.weekendEarliest ? rec.weekendEarliest : (tpl.flexWindow?.earliest ?? rec.preferredStart);
        const travel = tpl.kind === 'workout' ? (input.gymTravelMinutes ?? 0) : 0;
        return findSlot({
          date,
          tz,
          durationMinutes: tpl.durationMinutes,
          earliest,
          latest: tpl.flexWindow?.latest ?? '23:30',
          preferredStart: rec.preferredStart,
          busy,
          paddingBeforeMinutes: travel,
          paddingAfterMinutes: travel,
          notBefore: now,
        });
      };

      const adjacentToUsed = (d: LocalDate) => usedDays.has(addDays(d, -1)) || usedDays.has(addDays(d, 1));

      // candidate ordering: preferred days first, then a spread over the remaining days
      const preferred = rec.preferredDays?.length ? weekDays.filter((d) => rec.preferredDays!.includes(isoWeekday(d))) : [];
      const others = weekDays.filter((d) => !preferred.includes(d));
      const spreadPick = spreadIndices(others.length, Math.max(0, missingNs.length - preferred.length)).map((i) => others[i]!);
      const orderedCandidates = [
        ...preferred,
        ...spreadPick,
        ...others.filter((d) => !spreadPick.includes(d)),
      ].filter((d, i, arr) => arr.indexOf(d) === i);

      for (const n of missingNs) {
        let placed: { date: LocalDate; slot: { startAt: DateTime; endAt: DateTime } } | null = null;
        const passes = rec.avoidConsecutive ? [true, false] : [false];
        for (const strict of passes) {
          for (const d of orderedCandidates) {
            if (usedDays.has(d)) continue;
            if (strict && adjacentToUsed(d)) continue;
            const slot = placeOn(d);
            if (slot) {
              placed = { date: d, slot };
              break;
            }
          }
          if (placed) break;
        }
        const key = quotaOriginKey(tpl.id, week, n);
        if (!placed) {
          risks.push({
            templateId: tpl.id,
            templateKey: tpl.key,
            title: tpl.title,
            weekStart: week,
            missing: 1,
            message: `«${tpl.title}»: не нашлось свободного окна на этой неделе (${n}/${rec.count}).`,
          });
          continue;
        }
        usedDays.add(placed.date);
        created.push({
          kind: tpl.kind,
          title: tpl.title,
          priorityClass: tpl.priorityClass,
          localDate: placed.date,
          startAt: placed.slot.startAt,
          endAt: placed.slot.endAt,
          templateId: tpl.id,
          flexWindow: tpl.flexWindow,
          originKey: key,
          source: 'quota',
        });
        existingKeys.add(key);
      }
    }
  }

  return { events: created, risks };
}

/** All time-occupying intervals overlapping the local day. */
export function busyForDay(
  date: LocalDate,
  tz: string,
  existing: Pick<PlanEvent, 'startAt' | 'endAt' | 'status' | 'title'>[],
  extra: Busyish[] = [],
): BusyInterval[] {
  const { start, end } = dayBoundsUtc(date, tz);
  const all: BusyInterval[] = [];
  for (const e of existing) {
    if (!occupiesTime(e)) continue;
    if (e.startAt < end && e.endAt > start) all.push({ startAt: e.startAt, endAt: e.endAt, label: e.title });
  }
  for (const e of extra) {
    if (e.startAt < end && e.endAt > start) all.push({ startAt: e.startAt, endAt: e.endAt, label: e.label });
  }
  return all;
}

// re-export for convenience
export { findSlot } from './slots';
