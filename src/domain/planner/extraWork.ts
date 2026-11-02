import type { DateTime } from 'luxon';
import {
  addDays,
  formatRange,
  formatTime,
  isoWeekday,
  localTimeOf,
  minutesBetween,
  roundUpToStep,
  timeToMinutes,
  weekStartOf,
  zoned,
  type LocalDate,
  type LocalTime,
} from '../time';
import type { EventKind, EventPriority } from '../types';
import { KIND_LABELS } from '../types';
import type { PlanEvent } from './model';
import { occupiesTime } from './model';
import { findSlot, overlapsAny, type BusyInterval } from './slots';

/**
 * «Нужно поработать» (PRD §5.4). Pure function: computes a preview diff, never writes.
 * Invariants:
 *  - sleep is a hard boundary; it is never shortened automatically (PL-06);
 *  - meals only move inside their allowed window, otherwise the work pauses for the meal;
 *  - required-movable events (workouts, own projects) move later the same day or to another
 *    day of the same week; if impossible → explicit weekly target risk, never silent;
 *  - workouts are not placed before the extra work ends (+ buffer);
 *  - no time is planned in the past.
 */

export type ExtraWorkStartMode = 'after_work' | 'now' | 'at';

export interface ExtraWorkRequest {
  date: LocalDate;
  startMode: ExtraWorkStartMode;
  startTime?: LocalTime | null;
  durationMinutes: number;
  reason?: string | null;
}

export interface ExtraWorkPrefs {
  workDays: number[];
  workStart: LocalTime;
  workEnd: LocalTime;
  bedTime: LocalTime;
  overtimeWarnMinutes: number;
  gymTravelMinutes: number | null;
}

export interface ExtraWorkContext {
  now: DateTime;
  tz: string;
  prefs: ExtraWorkPrefs;
  /** All events of the ISO week containing `date` plus the next morning (any status). */
  events: PlanEvent[];
}

export interface TimeRef {
  startAt: string;
  endAt: string;
  localDate: LocalDate;
}

export interface PlannedChange {
  eventId: string;
  title: string;
  kind: EventKind;
  priorityClass: EventPriority;
  action: 'move' | 'cancel';
  from: TimeRef;
  to: TimeRef | null;
  reason: string;
  revision: number;
}

export interface PreviewConflict {
  code: 'PAST_DATE' | 'SLEEP_LIMIT' | 'NO_TIME_BEFORE_SLEEP' | 'IN_SLEEP' | 'INVALID_REQUEST';
  message: string;
  suggestedDurationMinutes?: number;
}

export interface WeeklyTargetRisk {
  eventId: string;
  title: string;
  message: string;
}

export interface ExtraWorkPreview {
  canCommit: boolean;
  requiresRiskAcknowledgement: boolean;
  request: ExtraWorkRequest;
  startAt: string | null;
  endAt: string | null;
  requestedMinutes: number;
  plannedMinutes: number;
  segments: { startAt: string; endAt: string }[];
  changes: PlannedChange[];
  conflicts: PreviewConflict[];
  weeklyTargetRisks: WeeklyTargetRisk[];
  warnings: string[];
  notes: string[];
  protectedEventsPreserved: boolean;
  weeklyExtraMinutes: number;
}

const MIN_SEGMENT = 10;
const AFTER_WORK_BUFFER = 15;
const ACTIVE_FOR_MOVE = new Set(['planned', 'notified', 'snoozed', 'unanswered']);

function ref(e: { startAt: DateTime; endAt: DateTime }, tz: string): TimeRef {
  return { startAt: e.startAt.toISO()!, endAt: e.endAt.toISO()!, localDate: e.startAt.setZone(tz).toISODate()! };
}

function emptyPreview(req: ExtraWorkRequest, conflict: PreviewConflict): ExtraWorkPreview {
  return {
    canCommit: false,
    requiresRiskAcknowledgement: false,
    request: req,
    startAt: null,
    endAt: null,
    requestedMinutes: req.durationMinutes,
    plannedMinutes: 0,
    segments: [],
    changes: [],
    conflicts: [conflict],
    weeklyTargetRisks: [],
    warnings: [],
    notes: [],
    protectedEventsPreserved: true,
    weeklyExtraMinutes: 0,
  };
}

interface Blocker extends BusyInterval {
  eventId?: string;
}

function walkSegments(start: DateTime, minutes: number, limit: DateTime, blockers: Blocker[]) {
  const sorted = [...blockers].sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
  const segments: { startAt: DateTime; endAt: DateTime }[] = [];
  let cursor = start;
  let remaining = minutes;
  let guard = 0;
  while (remaining > 0 && cursor < limit && guard++ < 200) {
    const covering = sorted.find((b) => b.startAt <= cursor && b.endAt > cursor);
    if (covering) {
      cursor = covering.endAt;
      continue;
    }
    const next = sorted.find((b) => b.startAt > cursor);
    let segEnd = cursor.plus({ minutes: remaining });
    if (next && next.startAt < segEnd) segEnd = next.startAt;
    if (limit < segEnd) segEnd = limit;
    const len = minutesBetween(cursor, segEnd);
    if (len >= MIN_SEGMENT || len === remaining) {
      const last = segments[segments.length - 1];
      if (last && last.endAt.equals(cursor)) last.endAt = segEnd;
      else segments.push({ startAt: cursor, endAt: segEnd });
      remaining -= len;
    }
    if (len <= 0) break;
    cursor = segEnd;
  }
  return { segments, shortfall: Math.max(0, remaining) };
}

export function resolveExtraWorkStart(
  req: ExtraWorkRequest,
  ctx: Pick<ExtraWorkContext, 'now' | 'tz' | 'prefs'>,
): { start: DateTime; notes: string[] } | PreviewConflict {
  const { now, tz, prefs } = ctx;
  const today = now.setZone(tz).toISODate()!;
  if (req.date < today) return { code: 'PAST_DATE', message: 'Нельзя запланировать работу на прошедший день.' };
  const notes: string[] = [];
  const isWorkDay = prefs.workDays.includes(isoWeekday(req.date));
  const workStartAt = zoned(req.date, prefs.workStart, tz);
  const workEndAt = zoned(req.date, prefs.workEnd, tz);
  const nowRounded = roundUpToStep(now, 5);

  let start: DateTime;
  if (req.startMode === 'at') {
    if (!req.startTime) return { code: 'INVALID_REQUEST', message: 'Укажи время начала.' };
    start = zoned(req.date, req.startTime, tz);
  } else if (req.startMode === 'now') {
    start = req.date === today ? nowRounded : isWorkDay ? workEndAt : zoned(req.date, '10:00', tz);
  } else {
    start = isWorkDay ? workEndAt : req.date === today ? nowRounded : zoned(req.date, '10:00', tz);
    if (!isWorkDay) notes.push('Сегодня выходной по графику — блок начнётся не с конца рабочего дня.');
  }

  if (isWorkDay && start >= workStartAt && start < workEndAt) {
    start = workEndAt;
    notes.push(`Основная работа идёт до ${prefs.workEnd} — дополнительный блок начнётся после неё.`);
  }
  if (start < nowRounded) {
    notes.push(
      `${formatTime(start, tz)} уже прошло — блок начнётся сейчас, в ${formatTime(nowRounded, tz)}. Задним числом время как отработанное не записывается.`,
    );
    start = nowRounded;
  }
  return { start, notes };
}

export function previewExtraWork(req: ExtraWorkRequest, ctx: ExtraWorkContext): ExtraWorkPreview {
  const { now, tz, prefs } = ctx;
  if (!Number.isInteger(req.durationMinutes) || req.durationMinutes < 15 || req.durationMinutes > 8 * 60) {
    return emptyPreview(req, { code: 'INVALID_REQUEST', message: 'Длительность — от 15 минут до 8 часов.' });
  }
  const resolved = resolveExtraWorkStart(req, ctx);
  if ('code' in resolved) return emptyPreview(req, resolved);
  const { start } = resolved;
  const notes = [...resolved.notes];
  const warnings: string[] = [];

  const events = ctx.events.filter(occupiesTime);

  // Sleep is the hard boundary of the evening.
  const sleep = events
    .filter((e) => e.kind === 'sleep' && e.startAt > start.minus({ hours: 12 }))
    .sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis())
    .find((e) => e.endAt > start);
  const bedDate = timeToMinutes(prefs.bedTime) >= 12 * 60 ? req.date : addDays(req.date, 1);
  const limit = sleep && sleep.startAt > start ? sleep.startAt : sleep ? start : zoned(bedDate, prefs.bedTime, tz);
  if (sleep && sleep.startAt <= start && sleep.endAt > start) {
    return emptyPreview(req, {
      code: 'IN_SLEEP',
      message: `Сейчас время сна (до ${formatTime(sleep.endAt, tz)}). Сон не сокращается — работу можно поставить на завтра.`,
    });
  }
  if (limit <= start) {
    return emptyPreview(req, {
      code: 'NO_TIME_BEFORE_SLEEP',
      message: `До сна (${formatTime(limit, tz)}) не осталось времени. Сон автоматически не сокращается — можно запланировать работу на другой день.`,
    });
  }

  const inWindow = (e: PlanEvent) => e.endAt > start && e.startAt < limit && e.kind !== 'sleep';
  const dayEvents = events.filter(inWindow);

  const isMeal = (e: PlanEvent) => e.priorityClass === 'protected' && e.kind.startsWith('meal') && !!e.flexWindow;
  const isHardBlocker = (e: PlanEvent) =>
    !ACTIVE_FOR_MOVE.has(e.status) ||
    e.priorityClass === 'fixed' ||
    (e.priorityClass === 'protected' && !isMeal(e));

  const hard: Blocker[] = dayEvents
    .filter(isHardBlocker)
    .map((e) => ({ startAt: e.startAt, endAt: e.endAt, label: e.title, eventId: e.id }));
  const meals = dayEvents.filter((e) => !isHardBlocker(e) && isMeal(e));

  // Decide meal handling iteratively: try to move each overlapped meal right after the work
  // inside its window; otherwise keep it and pause the work.
  const keptMeals = new Set<string>();
  const movedMeals = new Map<string, { startAt: DateTime; endAt: DateTime }>();
  let walk = walkSegments(start, req.durationMinutes, limit, hard);
  for (let iter = 0; iter < 4; iter++) {
    const blockers = [
      ...hard,
      ...meals.filter((m) => keptMeals.has(m.id)).map((m) => ({ startAt: m.startAt, endAt: m.endAt, label: m.title })),
    ];
    walk = walkSegments(start, req.durationMinutes, limit, blockers);
    const workEnd = walk.segments[walk.segments.length - 1]?.endAt ?? start;
    let changed = false;
    for (const meal of meals) {
      if (keptMeals.has(meal.id)) continue;
      const overlapsWork = walk.segments.some((s) => meal.startAt < s.endAt && s.startAt < meal.endAt);
      const moved = movedMeals.get(meal.id);
      if (moved) {
        // verify the moved slot is still clear of the (possibly longer) work
        if (walk.segments.some((s) => moved.startAt < s.endAt && s.startAt < moved.endAt)) {
          movedMeals.delete(meal.id);
          keptMeals.add(meal.id);
          changed = true;
        }
        continue;
      }
      if (!overlapsWork) continue;
      const duration = minutesBetween(meal.startAt, meal.endAt);
      const latest = zoned(meal.localDate, meal.flexWindow!.latest, tz);
      const candStart = workEnd;
      const candEnd = candStart.plus({ minutes: duration });
      const others = dayEvents.filter(
        (e) => e.id !== meal.id && e.priorityClass !== 'flexible' && e.priorityClass !== 'buffer' && !movedMeals.has(e.id),
      );
      const collides = overlapsAny(candStart, candEnd, [
        ...others.map((e) => ({ startAt: e.startAt, endAt: e.endAt })),
        ...[...movedMeals.values()],
      ]);
      if (candEnd <= latest && candEnd <= limit && !collides) {
        movedMeals.set(meal.id, { startAt: candStart, endAt: candEnd });
      } else {
        keptMeals.add(meal.id);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const segments = walk.segments;
  const plannedMinutes = segments.reduce((sum, s) => sum + minutesBetween(s.startAt, s.endAt), 0);
  const conflicts: PreviewConflict[] = [];
  if (walk.shortfall > 0) {
    const fit = Math.floor((req.durationMinutes - walk.shortfall) / 15) * 15;
    conflicts.push({
      code: 'SLEEP_LIMIT',
      message: `До сна (${formatTime(limit, tz)}) помещается только ${plannedMinutes} мин из ${req.durationMinutes}. Сон автоматически не сокращается.`,
      suggestedDurationMinutes: fit >= 15 ? fit : undefined,
    });
  }

  const changes: PlannedChange[] = [];
  for (const meal of meals) {
    const moved = movedMeals.get(meal.id);
    if (moved) {
      changes.push({
        eventId: meal.id,
        title: meal.title,
        kind: meal.kind,
        priorityClass: meal.priorityClass,
        action: 'move',
        from: ref(meal, tz),
        to: ref(moved, tz),
        reason: `${KIND_LABELS[meal.kind]} сдвинут в пределах допустимого окна ${meal.flexWindow!.earliest}–${meal.flexWindow!.latest}.`,
        revision: meal.revision,
      });
    } else if (keptMeals.has(meal.id)) {
      notes.push(`${meal.title} ${formatRange(meal.startAt, meal.endAt, tz)} сохранён — работа прервётся на это время.`);
    }
  }

  // Displace movable events that overlap the new work segments or moved meals.
  const occupiedByNew: BusyInterval[] = [
    ...segments.map((s) => ({ startAt: s.startAt, endAt: s.endAt, label: 'Дополнительная работа' })),
    ...[...movedMeals.values()].map((m) => ({ ...m, label: 'Еда' })),
  ];
  const lastWorkEnd = segments[segments.length - 1]?.endAt ?? start;
  const displaced = dayEvents
    .filter((e) => !isHardBlocker(e) && !isMeal(e))
    .filter((e) => overlapsAny(e.startAt, e.endAt, occupiedByNew))
    .sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
  const displacedIds = new Set(displaced.map((e) => e.id));

  // busy set used while re-placing displaced events
  const placedMoves: BusyInterval[] = [];
  const busyFor = () => [
    ...ctx.events.filter((e) => occupiesTime(e) && !displacedIds.has(e.id) && !movedMeals.has(e.id)).map((e) => ({
      startAt: e.startAt,
      endAt: e.endAt,
      label: e.title,
    })),
    ...occupiedByNew,
    ...placedMoves,
  ];

  const weekStart = weekStartOf(req.date);
  const weekEnd = addDays(weekStart, 6);
  const weeklyTargetRisks: WeeklyTargetRisk[] = [];

  for (const ev of displaced) {
    const duration = minutesBetween(ev.startAt, ev.endAt);
    const travel = ev.kind === 'workout' ? (prefs.gymTravelMinutes ?? 0) : 0;
    const originalTime = localTimeOf(ev.startAt, tz);
    const window = ev.flexWindow ?? { earliest: localTimeOf(lastWorkEnd, tz), latest: localTimeOf(limit, tz) };
    const notBeforeSameDay = lastWorkEnd.plus({ minutes: AFTER_WORK_BUFFER });

    let target: { startAt: DateTime; endAt: DateTime } | null = null;
    let reason = '';

    // 1) later the same day, after the extra work (+buffer), before sleep
    const sameDay = findSlot({
      date: req.date,
      tz,
      durationMinutes: duration,
      earliest: window.earliest,
      latest: window.latest,
      preferredStart: localTimeOf(notBeforeSameDay.plus({ minutes: travel }), tz),
      busy: busyFor(),
      paddingBeforeMinutes: travel,
      paddingAfterMinutes: travel,
      notBefore: notBeforeSameDay,
      stepMinutes: 15,
    });
    if (sameDay && sameDay.endAt <= limit) {
      target = sameDay;
      reason = `Сдвинуто на после дополнительной работы, в тот же день.`;
    }

    // 2) another day of the same week (never silently outside the week)
    if (!target && (ev.priorityClass === 'required_movable' || ev.kind === 'task')) {
      const sameTemplateDays = new Set(
        ctx.events
          .filter((e) => occupiesTime(e) && e.templateId && e.templateId === ev.templateId && e.id !== ev.id)
          .map((e) => e.localDate),
      );
      const candidates: LocalDate[] = [];
      for (let d = addDays(req.date, 1); d <= weekEnd; d = addDays(d, 1)) candidates.push(d);
      const passes = ev.kind === 'workout' ? [true, false] : [false];
      outer: for (const strict of passes) {
        for (const d of candidates) {
          if (sameTemplateDays.has(d)) continue;
          if (strict && (sameTemplateDays.has(addDays(d, -1)) || sameTemplateDays.has(addDays(d, 1)))) continue;
          const slot = findSlot({
            date: d,
            tz,
            durationMinutes: duration,
            earliest: window.earliest,
            latest: window.latest,
            preferredStart: originalTime,
            busy: busyFor(),
            paddingBeforeMinutes: travel,
            paddingAfterMinutes: travel,
            notBefore: now,
          });
          if (slot) {
            target = slot;
            reason = strict || ev.kind !== 'workout'
              ? `Перенесено на другой день этой недели.`
              : `Перенесено на другой день этой недели (рядом с другой тренировкой — проверь восстановление).`;
            break outer;
          }
        }
      }
    }

    if (target) {
      placedMoves.push({ ...target, label: ev.title });
      changes.push({
        eventId: ev.id,
        title: ev.title,
        kind: ev.kind,
        priorityClass: ev.priorityClass,
        action: 'move',
        from: ref(ev, tz),
        to: ref(target, tz),
        reason,
        revision: ev.revision,
      });
      continue;
    }

    const cancelReason =
      ev.priorityClass === 'buffer'
        ? 'Буферное время будет занято работой.'
        : ev.priorityClass === 'required_movable'
          ? 'Не нашлось свободного окна до конца недели.'
          : 'Вытеснено дополнительной работой — свободного окна сегодня нет.';
    changes.push({
      eventId: ev.id,
      title: ev.title,
      kind: ev.kind,
      priorityClass: ev.priorityClass,
      action: 'cancel',
      from: ref(ev, tz),
      to: null,
      reason: cancelReason,
      revision: ev.revision,
    });
    if (ev.priorityClass === 'required_movable') {
      weeklyTargetRisks.push({
        eventId: ev.id,
        title: ev.title,
        message: `«${ev.title}» не помещается на этой неделе — недельная цель под угрозой. Можно сократить переработку, выбрать другой день или перенести вручную.`,
      });
    }
  }

  // weekly overtime accumulation
  const weekStartUtc = zoned(weekStart, '00:00', tz);
  const weekEndUtc = zoned(addDays(weekStart, 7), '00:00', tz);
  const existingExtra = events
    .filter((e) => e.kind === 'extra_work' && e.startAt >= weekStartUtc && e.startAt < weekEndUtc)
    .reduce((sum, e) => sum + minutesBetween(e.startAt, e.endAt), 0);
  const weeklyExtraMinutes = existingExtra + plannedMinutes;
  if (weeklyExtraMinutes > prefs.overtimeWarnMinutes) {
    warnings.push(
      `За неделю переработки составят ${Math.round((weeklyExtraMinutes / 60) * 10) / 10} ч — больше выбранного порога ${Math.round((prefs.overtimeWarnMinutes / 60) * 10) / 10} ч. Это не запрет, просто проверь, хватает ли времени на отдых.`,
    );
  }

  const protectedEventsPreserved = !changes.some((c) => c.priorityClass === 'protected' && c.action === 'cancel');
  const canCommit = conflicts.length === 0 && segments.length > 0;

  return {
    canCommit,
    requiresRiskAcknowledgement: weeklyTargetRisks.length > 0,
    request: req,
    startAt: segments[0]?.startAt.toISO() ?? start.toISO()!,
    endAt: segments[segments.length - 1]?.endAt.toISO() ?? null,
    requestedMinutes: req.durationMinutes,
    plannedMinutes,
    segments: segments.map((s) => ({ startAt: s.startAt.toISO()!, endAt: s.endAt.toISO()! })),
    changes,
    conflicts,
    weeklyTargetRisks,
    warnings,
    notes,
    protectedEventsPreserved,
    weeklyExtraMinutes,
  };
}

/** Stable fingerprint of a preview, used to make sure the committed diff equals the shown one. */
export function previewFingerprint(p: ExtraWorkPreview): string {
  return JSON.stringify({
    s: p.segments,
    c: p.changes.map((c) => [c.eventId, c.action, c.to?.startAt ?? null]),
  });
}
