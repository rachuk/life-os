import { DateTime } from 'luxon';
import { z } from 'zod';
import type { PlanEvent } from '@/domain/planner/model';
import { occupiesTime } from '@/domain/planner/model';
import { materializeRange, busyForDay } from '@/domain/planner/materialize';
import {
  previewExtraWork,
  previewFingerprint,
  type ExtraWorkPreview,
  type ExtraWorkRequest,
} from '@/domain/planner/extraWork';
import { findSlot } from '@/domain/planner/slots';
import {
  addDays,
  dayBoundsUtc,
  isLocalDate,
  isLocalTime,
  isoWeekday,
  localDateOf,
  localTimeOf,
  weekStartOf,
  zoned,
  type LocalDate,
} from '@/domain/time';
import type { EventKind, EventPriority, EventStatus } from '@/domain/types';
import { one, type Tx } from '../db';
import { AppError, notFound } from '../http';
import { audit } from './audit';
import { acknowledgeEventNotifications, reconcileReminders } from './notifications';
import type { UserContext } from './profile';

export interface EventRow {
  id: string;
  userId: string;
  localDate: string;
  startAt: Date;
  endAt: Date;
  templateId: string | null;
  taskId: string | null;
  planVersionId: string | null;
  kind: EventKind;
  title: string;
  priorityClass: EventPriority;
  status: EventStatus;
  source: string;
  originKey: string | null;
  flexWindow: { earliest: string; latest: string } | null;
  actualStart: Date | null;
  actualEnd: Date | null;
  actualMinutes: number | null;
  notes: string | null;
  reason: string | null;
  revision: number;
  statusChangedAt: Date | null;
}

export function toPlanEvent(r: EventRow): PlanEvent {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    priorityClass: r.priorityClass,
    status: r.status,
    localDate: r.localDate,
    startAt: DateTime.fromJSDate(r.startAt, { zone: 'utc' }),
    endAt: DateTime.fromJSDate(r.endAt, { zone: 'utc' }),
    templateId: r.templateId,
    taskId: r.taskId,
    flexWindow: r.flexWindow,
    originKey: r.originKey,
    source: r.source,
    revision: r.revision,
  };
}

/** JSON-safe event for API responses. */
export function serializeEvent(r: EventRow) {
  return {
    id: r.id,
    localDate: r.localDate,
    startAt: r.startAt.toISOString(),
    endAt: r.endAt.toISOString(),
    kind: r.kind,
    title: r.title,
    priorityClass: r.priorityClass,
    status: r.status,
    source: r.source,
    templateId: r.templateId,
    taskId: r.taskId,
    flexWindow: r.flexWindow,
    actualStart: r.actualStart?.toISOString() ?? null,
    actualEnd: r.actualEnd?.toISOString() ?? null,
    actualMinutes: r.actualMinutes,
    notes: r.notes,
    reason: r.reason,
    revision: r.revision,
  };
}
export type SerializedEvent = ReturnType<typeof serializeEvent>;

export async function loadEventRows(tx: Tx, userId: string, from: DateTime, to: DateTime): Promise<EventRow[]> {
  return tx<EventRow[]>`
    select * from schedule_events
    where user_id = ${userId} and start_at < ${to.toJSDate()} and end_at > ${from.toJSDate()}
    order by start_at, end_at`;
}

export async function getEventRow(tx: Tx, userId: string, eventId: string): Promise<EventRow> {
  const [r] = await tx<EventRow[]>`select * from schedule_events where id = ${eventId} and user_id = ${userId}`;
  if (!r) throw notFound('Событие');
  return r;
}

// ---------------------------------------------------------------------------
// plan versions (optimistic concurrency per user-week, PRD §17.2)
// ---------------------------------------------------------------------------
export async function lockWeek(tx: Tx, userId: string, weekStart: LocalDate): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`${userId}:${weekStart}`}, 0))`;
}

export async function currentPlanVersion(tx: Tx, userId: string, weekStart: LocalDate): Promise<number> {
  const [r] = await tx<{ v: number | null }[]>`
    select max(version)::int as v from plan_versions where user_id = ${userId} and week_start = ${weekStart}`;
  return r?.v ?? 0;
}

export async function createPlanVersion(
  tx: Tx,
  userId: string,
  weekStart: LocalDate,
  v: { source: string; summary: string; diff?: unknown; localDate?: LocalDate | null; actor?: string; revertsVersionId?: string | null },
): Promise<{ id: string; version: number }> {
  const next = (await currentPlanVersion(tx, userId, weekStart)) + 1;
  const [r] = await tx<{ id: string; version: number }[]>`
    insert into plan_versions (user_id, week_start, version, local_date, status, source, summary, diff_json, actor, confirmed_at, reverts_version_id)
    values (${userId}, ${weekStart}, ${next}, ${v.localDate ?? null}, 'confirmed', ${v.source}, ${v.summary},
            ${tx.json((v.diff ?? {}) as never)}, ${v.actor ?? 'user'}, now(), ${v.revertsVersionId ?? null})
    returning id, version`;
  return r!;
}

async function recordChange(
  tx: Tx,
  userId: string,
  versionId: string,
  c: { eventId: string | null; action: string; from?: unknown; to?: unknown; reason?: string | null; actor?: string },
) {
  await tx`insert into plan_changes (user_id, version_id, event_id, action, from_json, to_json, reason, actor)
           values (${userId}, ${versionId}, ${c.eventId}, ${c.action}, ${c.from ? tx.json(c.from as never) : null},
                   ${c.to ? tx.json(c.to as never) : null}, ${c.reason ?? null}, ${c.actor ?? 'user'})`;
}

// ---------------------------------------------------------------------------
// materialisation
// ---------------------------------------------------------------------------
export async function ensureMaterialized(
  tx: Tx,
  ctx: UserContext,
  now: DateTime,
  fromDate: LocalDate,
  toDate: LocalDate,
): Promise<{ created: number; risks: ReturnType<typeof materializeRange>['risks'] }> {
  if (!ctx.profile.isOnboarded || !ctx.templates.length) return { created: 0, risks: [] };
  const from = zoned(weekStartOf(fromDate), '00:00', ctx.tz).minus({ days: 1 });
  const to = zoned(addDays(weekStartOf(toDate), 8), '00:00', ctx.tz);
  const existing = (await loadEventRows(tx, ctx.userId, from, to)).map(toPlanEvent);
  // origin keys of instances moved far away must still count as existing
  const keyed = await tx<{ originKey: string }[]>`
    select origin_key from schedule_events
    where user_id = ${ctx.userId} and origin_key is not null and local_date between ${addDays(fromDate, -7)} and ${addDays(toDate, 7)}`;
  const res = materializeRange({
    templates: ctx.templates,
    tz: ctx.tz,
    fromDate,
    toDate,
    now,
    existing,
    extraOriginKeys: keyed.map((k) => k.originKey),
    gymTravelMinutes: ctx.prefs.gymTravelMinutes,
  });
  let created = 0;
  for (const e of res.events) {
    const rows = await tx`
      insert into schedule_events (user_id, local_date, start_at, end_at, template_id, kind, title, priority_class, status, source, origin_key, flex_window)
      values (${ctx.userId}, ${e.localDate}, ${e.startAt.toJSDate()}, ${e.endAt.toJSDate()}, ${e.templateId}, ${e.kind}, ${e.title},
              ${e.priorityClass}, 'planned', ${e.source}, ${e.originKey}, ${e.flexWindow ? tx.json(e.flexWindow) : null})
      on conflict (user_id, origin_key) where origin_key is not null do nothing
      returning id`;
    created += rows.length;
  }
  if (created) await reconcileReminders(tx, ctx, now);
  return { created, risks: res.risks };
}

/** Rebuild future untouched template instances after the routine changed. */
export async function regenerateFuture(tx: Tx, ctx: UserContext, now: DateTime): Promise<{ removed: number; created: number }> {
  const removed = await tx`
    delete from schedule_events
    where user_id = ${ctx.userId} and start_at > ${now.toJSDate()} and status = 'planned' and revision = 1
      and (origin_key like 'tpl:%' or origin_key like 'quota:%')
    returning id`;
  const today = localDateOf(now, ctx.tz);
  const { created } = await ensureMaterialized(tx, ctx, now, today, addDays(weekStartOf(today), 13));
  const week = weekStartOf(today);
  await lockWeek(tx, ctx.userId, week);
  await createPlanVersion(tx, ctx.userId, week, { source: 'regenerate', summary: 'План перестроен по обновлённому распорядку', actor: 'user' });
  await reconcileReminders(tx, ctx, now);
  return { removed: removed.length, created };
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
export async function dayEvents(tx: Tx, ctx: UserContext, date: LocalDate): Promise<EventRow[]> {
  const { start, end } = dayBoundsUtc(date, ctx.tz);
  const rows = await loadEventRows(tx, ctx.userId, start, end);
  // events belonging to this date + a night that started after midnight today
  return rows.filter((r) => r.localDate === date || localDateOf(r.startAt, ctx.tz) === date);
}

export interface WeekProgress {
  workouts: { target: number; planned: number; completed: number; skipped: number };
  projectMinutes: { target: number; planned: number; completed: number };
  extraWorkMinutes: { planned: number; actual: number; warnAt: number };
}

export async function weekProgress(tx: Tx, ctx: UserContext, weekStart: LocalDate): Promise<WeekProgress> {
  const start = zoned(weekStart, '00:00', ctx.tz);
  const end = zoned(addDays(weekStart, 7), '00:00', ctx.tz);
  const rows = await loadEventRows(tx, ctx.userId, start, end);
  const inWeek = rows.filter((r) => r.localDate >= weekStart && r.localDate <= addDays(weekStart, 6));
  const mins = (r: EventRow) => Math.round((r.endAt.getTime() - r.startAt.getTime()) / 60000);
  const workouts = inWeek.filter((r) => r.kind === 'workout');
  const manualSessions = await tx<{ n: number }[]>`
    select count(*)::int as n from workout_sessions
    where user_id = ${ctx.userId} and status = 'completed' and schedule_event_id is null
      and local_date between ${weekStart} and ${addDays(weekStart, 6)}`;
  const projects = inWeek.filter((r) => r.kind === 'own_project');
  const extra = inWeek.filter((r) => r.kind === 'extra_work' && r.status !== 'cancelled');
  return {
    workouts: {
      target: ctx.prefs.targets.workouts,
      planned: workouts.filter((r) => occupiesTime(r)).length,
      completed: workouts.filter((r) => r.status === 'completed').length + (manualSessions[0]?.n ?? 0),
      skipped: workouts.filter((r) => r.status === 'skipped').length,
    },
    projectMinutes: {
      target: ctx.prefs.targets.projectMinutes,
      planned: projects.filter((r) => occupiesTime(r)).reduce((s, r) => s + mins(r), 0),
      completed: projects.filter((r) => r.status === 'completed').reduce((s, r) => s + (r.actualMinutes ?? mins(r)), 0),
    },
    extraWorkMinutes: {
      planned: extra.reduce((s, r) => s + mins(r), 0),
      actual: extra.filter((r) => r.status === 'completed').reduce((s, r) => s + (r.actualMinutes ?? mins(r)), 0),
      warnAt: ctx.prefs.overtimeWarnMinutes,
    },
  };
}

// ---------------------------------------------------------------------------
// extra work
// ---------------------------------------------------------------------------
export const extraWorkRequestSchema = z.object({
  date: z.string().refine(isLocalDate, 'Дата YYYY-MM-DD'),
  startMode: z.enum(['after_work', 'now', 'at']).default('after_work'),
  startTime: z.string().refine(isLocalTime, 'Время ЧЧ:ММ').nullable().optional(),
  durationMinutes: z.number().int().min(15).max(480),
  reason: z.string().trim().max(120).nullable().optional(),
});

export const extraWorkCommitSchema = extraWorkRequestSchema.extend({
  expectedPlanVersion: z.number().int().min(0),
  acknowledgeRisks: z.boolean().default(false),
  fingerprint: z.string().max(20000).optional(),
});

async function weekPlanEvents(tx: Tx, ctx: UserContext, date: LocalDate): Promise<PlanEvent[]> {
  const ws = weekStartOf(date);
  const from = zoned(ws, '00:00', ctx.tz).minus({ hours: 12 });
  const to = zoned(addDays(ws, 8), '12:00', ctx.tz);
  return (await loadEventRows(tx, ctx.userId, from, to)).map(toPlanEvent);
}

export async function extraWorkPreview(
  tx: Tx,
  ctx: UserContext,
  now: DateTime,
  req: ExtraWorkRequest,
): Promise<ExtraWorkPreview & { basePlanVersion: number; newPlanVersion: number; fingerprint: string }> {
  await ensureMaterialized(tx, ctx, now, req.date, addDays(weekStartOf(req.date), 6));
  const events = await weekPlanEvents(tx, ctx, req.date);
  const preview = previewExtraWork(req, {
    now,
    tz: ctx.tz,
    prefs: {
      workDays: ctx.prefs.workDays,
      workStart: ctx.prefs.workStart,
      workEnd: ctx.prefs.workEnd,
      bedTime: ctx.prefs.bedTime,
      overtimeWarnMinutes: ctx.prefs.overtimeWarnMinutes,
      gymTravelMinutes: ctx.prefs.gymTravelMinutes,
    },
    events,
  });
  const base = await currentPlanVersion(tx, ctx.userId, weekStartOf(req.date));
  return { ...preview, basePlanVersion: base, newPlanVersion: base + 1, fingerprint: previewFingerprint(preview) };
}

export interface CommitResult {
  versionId: string;
  version: number;
  createdEventIds: string[];
  preview: ExtraWorkPreview;
}

/**
 * Atomic commit (PRD §17.2): version check under an advisory lock, recompute the preview from
 * fresh data, apply events + changes + history + audit, then reconcile reminders — one transaction.
 */
export async function extraWorkCommit(
  tx: Tx,
  ctx: UserContext,
  now: DateTime,
  input: z.infer<typeof extraWorkCommitSchema>,
  actor: 'user' | 'telegram' = 'user',
): Promise<CommitResult> {
  const week = weekStartOf(input.date);
  await lockWeek(tx, ctx.userId, week);
  const current = await currentPlanVersion(tx, ctx.userId, week);
  const req: ExtraWorkRequest = {
    date: input.date,
    startMode: input.startMode,
    startTime: input.startTime ?? null,
    durationMinutes: input.durationMinutes,
    reason: input.reason ?? null,
  };
  const fresh = await extraWorkPreview(tx, ctx, now, req);
  if (current !== input.expectedPlanVersion || (input.fingerprint && input.fingerprint !== fresh.fingerprint)) {
    throw new AppError('PLAN_VERSION_CONFLICT', 'План изменился, пока ты смотрел предпросмотр. Вот обновлённый вариант.', 409, {
      preview: fresh,
    });
  }
  if (!fresh.canCommit) throw new AppError('CANNOT_COMMIT', fresh.conflicts[0]?.message ?? 'Нельзя применить изменения', 422, { preview: fresh });
  if (fresh.requiresRiskAcknowledgement && !input.acknowledgeRisks) {
    throw new AppError('RISK_NOT_ACKNOWLEDGED', 'Подтверди, что понимаешь риск для недельной цели', 422, { preview: fresh });
  }

  const summary = `Дополнительная работа ${fresh.plannedMinutes} мин${req.reason ? ` (${req.reason})` : ''}`;
  const version = await createPlanVersion(tx, ctx.userId, week, {
    source: 'extra_work',
    summary,
    localDate: input.date,
    actor,
    diff: { request: req, segments: fresh.segments, changes: fresh.changes, risks: fresh.weeklyTargetRisks },
  });

  const created: string[] = [];
  for (const [i, s] of fresh.segments.entries()) {
    const [row] = await tx<{ id: string }[]>`
      insert into schedule_events (user_id, local_date, start_at, end_at, kind, title, priority_class, status, source, origin_key, plan_version_id, notes)
      values (${ctx.userId}, ${input.date}, ${s.startAt}, ${s.endAt}, 'extra_work', 'Дополнительная работа', 'fixed', 'planned',
              'extra_work', ${`xw:${version.id}:${i}`}, ${version.id}, ${req.reason ?? null})
      returning id`;
    created.push(row!.id);
    await recordChange(tx, ctx.userId, version.id, { eventId: row!.id, action: 'create', to: s, reason: req.reason, actor });
  }

  for (const c of fresh.changes) {
    if (c.action === 'move' && c.to) {
      const res = await tx`
        update schedule_events set start_at = ${c.to.startAt}, end_at = ${c.to.endAt}, local_date = ${c.to.localDate},
          revision = revision + 1, plan_version_id = ${version.id}, reason = ${c.reason}
        where id = ${c.eventId} and user_id = ${ctx.userId} and revision = ${c.revision}
        returning id`;
      if (!res.length) throw new AppError('PLAN_VERSION_CONFLICT', 'Событие изменилось параллельно — обнови предпросмотр.', 409);
    } else if (c.action === 'cancel') {
      const res = await tx`
        update schedule_events set status = 'cancelled', status_changed_at = now(), revision = revision + 1,
          plan_version_id = ${version.id}, reason = ${c.reason}
        where id = ${c.eventId} and user_id = ${ctx.userId} and revision = ${c.revision}
        returning id`;
      if (!res.length) throw new AppError('PLAN_VERSION_CONFLICT', 'Событие изменилось параллельно — обнови предпросмотр.', 409);
    }
    await recordChange(tx, ctx.userId, version.id, { eventId: c.eventId, action: c.action, from: c.from, to: c.to, reason: c.reason, actor });
  }
  await audit(tx, ctx.userId, 'plan_version', version.id, 'extra_work_committed', {
    minutes: fresh.plannedMinutes,
    changes: fresh.changes.length,
  }, actor === 'telegram' ? 'telegram' : 'web');
  await reconcileReminders(tx, ctx, now);
  return { versionId: version.id, version: version.version, createdEventIds: created, preview: fresh };
}

/** Undo a committed version (PL-08): restore moved/cancelled events, cancel created ones. */
export async function undoVersion(tx: Tx, ctx: UserContext, now: DateTime, versionId: string, actor = 'user') {
  const [v] = await tx<{ id: string; weekStart: string; status: string; source: string; version: number; summary: string | null }[]>`
    select id, week_start, status, source, version, summary from plan_versions where id = ${versionId} and user_id = ${ctx.userId}`;
  if (!v) throw notFound('Версия плана');
  if (v.status === 'reverted') throw new AppError('ALREADY_REVERTED', 'Эти изменения уже отменены', 409);
  await lockWeek(tx, ctx.userId, v.weekStart);
  const changes = await tx<{ eventId: string | null; action: string; fromJson: { startAt: string; endAt: string; localDate: string } | null }[]>`
    select event_id, action, from_json from plan_changes where version_id = ${versionId} order by created_at desc`;
  const undo = await createPlanVersion(tx, ctx.userId, v.weekStart, {
    source: 'undo',
    summary: `Отмена: ${v.summary ?? v.source}`,
    actor,
    revertsVersionId: v.id,
  });
  const skipped: string[] = [];
  for (const c of changes) {
    if (!c.eventId) continue;
    if (c.action === 'create') {
      await tx`update schedule_events set status = 'cancelled', status_changed_at = now(), revision = revision + 1,
                 reason = 'Отменено пользователем', plan_version_id = ${undo.id}
               where id = ${c.eventId} and user_id = ${ctx.userId} and status not in ('completed')`;
      await recordChange(tx, ctx.userId, undo.id, { eventId: c.eventId, action: 'cancel', reason: 'undo', actor });
    } else if ((c.action === 'move' || c.action === 'cancel') && c.fromJson) {
      const res = await tx`
        update schedule_events set start_at = ${c.fromJson.startAt}, end_at = ${c.fromJson.endAt}, local_date = ${c.fromJson.localDate},
          status = case when status = 'cancelled' then 'planned' else status end,
          revision = revision + 1, plan_version_id = ${undo.id}, reason = null
        where id = ${c.eventId} and user_id = ${ctx.userId} and plan_version_id = ${versionId}
        returning id, title`;
      if (res.length) await recordChange(tx, ctx.userId, undo.id, { eventId: c.eventId, action: 'restore', to: c.fromJson, reason: 'undo', actor });
      else skipped.push(c.eventId);
    }
  }
  await tx`update plan_versions set status = 'reverted' where id = ${versionId}`;
  await audit(tx, ctx.userId, 'plan_version', versionId, 'reverted', { skipped: skipped.length }, 'web');
  await reconcileReminders(tx, ctx, now);
  return { undoVersionId: undo.id, version: undo.version, skippedEventIds: skipped };
}

// ---------------------------------------------------------------------------
// event transitions (PRD §5.2) — status changes, snooze, reschedule
// ---------------------------------------------------------------------------
export const transitionSchema = z.object({
  action: z.enum(['start', 'complete', 'skip', 'snooze', 'reschedule', 'cancel', 'reopen', 'needs_reschedule']),
  expectedRevision: z.number().int().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
  actualMinutes: z.number().int().min(0).max(1440).nullable().optional(),
  snoozeMinutes: z.number().int().min(5).max(180).optional(),
  toDate: z.string().refine(isLocalDate).optional(),
  toTime: z.string().refine(isLocalTime).optional(),
});
export type TransitionInput = z.infer<typeof transitionSchema>;

const ALLOWED: Record<TransitionInput['action'], EventStatus[]> = {
  start: ['planned', 'notified', 'snoozed', 'unanswered', 'rescheduled'],
  complete: ['planned', 'notified', 'snoozed', 'unanswered', 'started', 'rescheduled'],
  skip: ['planned', 'notified', 'snoozed', 'unanswered', 'started', 'rescheduled'],
  snooze: ['planned', 'notified', 'snoozed'],
  reschedule: ['planned', 'notified', 'snoozed', 'unanswered', 'rescheduled', 'skipped'],
  cancel: ['planned', 'notified', 'snoozed', 'unanswered', 'rescheduled'],
  reopen: ['completed', 'skipped', 'cancelled', 'started', 'unanswered'],
  needs_reschedule: ['planned', 'notified', 'snoozed', 'unanswered'],
};

const TARGET: Partial<Record<TransitionInput['action'], EventStatus>> = {
  start: 'started',
  complete: 'completed',
  skip: 'skipped',
  snooze: 'snoozed',
  cancel: 'cancelled',
  reopen: 'planned',
  needs_reschedule: 'rescheduled',
};

export interface TransitionResult {
  event: SerializedEvent;
  changed: boolean;
  message: string;
  warnings: string[];
}

export async function transitionEvent(
  tx: Tx,
  ctx: UserContext,
  now: DateTime,
  eventId: string,
  input: TransitionInput,
  source: 'web' | 'telegram' | 'push' = 'web',
): Promise<TransitionResult> {
  const [ev] = await tx<EventRow[]>`select * from schedule_events where id = ${eventId} and user_id = ${ctx.userId} for update`;
  if (!ev) throw notFound('Событие');
  if (input.expectedRevision !== undefined && input.expectedRevision !== ev.revision) {
    throw new AppError('REVISION_CONFLICT', 'Событие уже изменили в другом окне. Обнови экран.', 409, { event: serializeEvent(ev) });
  }
  const target = TARGET[input.action];
  // idempotent repeat of the same answer (double tap, repeated Telegram button)
  if (target && ev.status === target && input.action !== 'snooze') {
    return { event: serializeEvent(ev), changed: false, message: 'Уже отмечено', warnings: [] };
  }
  if (!ALLOWED[input.action].includes(ev.status)) {
    throw new AppError('INVALID_TRANSITION', `Нельзя «${input.action}» для события в статусе «${ev.status}»`, 409, { event: serializeEvent(ev) });
  }

  const warnings: string[] = [];
  let updated: EventRow;
  const nowJs = now.toJSDate();
  const reason = input.reason ?? null;

  if (input.action === 'snooze' || input.action === 'reschedule') {
    const durMin = Math.round((ev.endAt.getTime() - ev.startAt.getTime()) / 60000);
    let newStart: DateTime;
    let newDate: LocalDate;
    if (input.action === 'snooze') {
      const by = input.snoozeMinutes ?? 15;
      newStart = DateTime.fromJSDate(ev.startAt, { zone: 'utc' }).plus({ minutes: by });
      if (newStart < now) newStart = now.plus({ minutes: by }).startOf('minute');
      newDate = localDateOf(newStart, ctx.tz);
    } else {
      if (!input.toDate || !input.toTime) throw new AppError('BAD_REQUEST', 'Укажи новую дату и время', 400);
      newDate = input.toDate;
      newStart = zoned(input.toDate, input.toTime, ctx.tz);
      if (newStart < now.minus({ minutes: 1 })) throw new AppError('IN_PAST', 'Нельзя перенести на прошедшее время', 422);
    }
    const newEnd = newStart.plus({ minutes: durMin });
    if (ev.flexWindow && input.action === 'snooze') {
      const latest = zoned(ev.localDate, ev.flexWindow.latest, ctx.tz);
      if (newEnd > latest) warnings.push(`Выходит за допустимое окно (до ${ev.flexWindow.latest}).`);
    }
    // conflict check against fixed/protected events
    const dayRows = await loadEventRows(tx, ctx.userId, newStart.minus({ hours: 1 }), newEnd.plus({ hours: 1 }));
    const clash = dayRows.find(
      (r) =>
        r.id !== ev.id &&
        occupiesTime(r) &&
        (r.priorityClass === 'fixed' || r.priorityClass === 'protected') &&
        !['work', 'morning_routine'].includes(r.kind) &&
        r.startAt < newEnd.toJSDate() &&
        newStart.toJSDate() < r.endAt,
    );
    if (clash) warnings.push(`Пересекается с «${clash.title}» ${localTimeOf(clash.startAt, ctx.tz)}.`);
    if (weekStartOf(newDate) !== weekStartOf(ev.localDate)) warnings.push('Перенос на другую неделю — проверь недельную цель.');

    const week = weekStartOf(ev.localDate);
    await lockWeek(tx, ctx.userId, week);
    const version = await createPlanVersion(tx, ctx.userId, week, {
      source: input.action,
      summary: `${input.action === 'snooze' ? 'Отложено' : 'Перенесено'}: ${ev.title}`,
      localDate: ev.localDate,
      actor: source === 'telegram' ? 'telegram' : 'user',
    });
    updated = one(await tx<EventRow[]>`
      update schedule_events set start_at = ${newStart.toJSDate()}, end_at = ${newEnd.toJSDate()}, local_date = ${newDate},
        status = ${input.action === 'snooze' ? 'snoozed' : 'planned'}, status_changed_at = now(), revision = revision + 1,
        reason = ${reason}, plan_version_id = ${version.id}
      where id = ${ev.id} returning *`);
    await recordChange(tx, ctx.userId, version.id, {
      eventId: ev.id,
      action: input.action === 'snooze' ? 'snooze' : 'reschedule',
      from: { startAt: ev.startAt.toISOString(), endAt: ev.endAt.toISOString(), localDate: ev.localDate },
      to: { startAt: newStart.toISO(), endAt: newEnd.toISO(), localDate: newDate },
      reason,
      actor: source,
    });
    if (ev.taskId) await tx`update tasks set planned_at = ${newStart.toJSDate()} where id = ${ev.taskId} and user_id = ${ctx.userId}`;
  } else {
    const next = target!;
    const actualMinutes =
      input.action === 'complete'
        ? (input.actualMinutes ??
          (ev.actualStart ? Math.max(1, Math.round((nowJs.getTime() - ev.actualStart.getTime()) / 60000)) : null))
        : null;
    updated = one(await tx<EventRow[]>`
      update schedule_events set
        status = ${next},
        status_changed_at = now(),
        actual_start = case when ${input.action} = 'start' then ${nowJs}::timestamptz
                            when ${input.action} = 'reopen' then null else actual_start end,
        actual_end = case when ${input.action} = 'complete' then ${nowJs}::timestamptz
                          when ${input.action} = 'reopen' then null else actual_end end,
        actual_minutes = case when ${input.action} = 'complete' then ${actualMinutes}::int
                              when ${input.action} = 'reopen' then null else actual_minutes end,
        reason = case when ${reason}::text is not null then ${reason}::text else reason end,
        revision = revision + 1
      where id = ${ev.id} returning *`);
    if (ev.taskId && (input.action === 'complete' || input.action === 'reopen')) {
      await tx`update tasks set status = ${input.action === 'complete' ? 'done' : 'scheduled'},
                 completed_at = ${input.action === 'complete' ? nowJs : null},
                 actual_minutes = coalesce(${actualMinutes}, actual_minutes)
               where id = ${ev.taskId} and user_id = ${ctx.userId}`;
    }
  }

  if (updated.kind === 'skill' && input.action === 'complete') {
    const { practiceFromEvent } = await import('./skills');
    await practiceFromEvent(tx, ctx.userId, {
      id: updated.id,
      templateId: updated.templateId,
      localDate: updated.localDate,
      minutes: updated.actualMinutes ?? Math.round((updated.endAt.getTime() - updated.startAt.getTime()) / 60000),
    });
  }
  await audit(tx, ctx.userId, 'schedule_event', ev.id, `transition:${input.action}`, { from: ev.status, to: updated.status, reason }, source);
  await acknowledgeEventNotifications(tx, ctx.userId, ev.id, input.action);
  await reconcileReminders(tx, ctx, now, { eventIds: [ev.id] });

  const messages: Record<string, string> = {
    start: 'Отмечено: начато',
    complete: 'Отмечено: выполнено',
    skip: 'Отмечено: пропущено',
    snooze: 'Отложено',
    reschedule: 'Перенесено',
    cancel: 'Отменено',
    reopen: 'Отметка снята',
    needs_reschedule: 'Нужно перенести — выбери время',
  };
  return { event: serializeEvent(updated), changed: true, message: messages[input.action] ?? 'Готово', warnings };
}

// ---------------------------------------------------------------------------
// manual events & scheduling tasks
// ---------------------------------------------------------------------------
export const createEventSchema = z.object({
  date: z.string().refine(isLocalDate),
  startTime: z.string().refine(isLocalTime),
  durationMinutes: z.number().int().min(5).max(24 * 60),
  title: z.string().trim().min(1).max(200),
  kind: z.enum(['custom', 'task', 'own_project', 'workout', 'free_time', 'meal_lunch', 'meal_dinner', 'snack']).default('custom'),
  priorityClass: z.enum(['fixed', 'protected', 'required_movable', 'flexible', 'buffer']).default('flexible'),
  taskId: z.string().uuid().nullable().optional(),
});

export async function createManualEvent(tx: Tx, ctx: UserContext, now: DateTime, input: z.infer<typeof createEventSchema>, actor = 'user') {
  const start = zoned(input.date, input.startTime, ctx.tz);
  const end = start.plus({ minutes: input.durationMinutes });
  const rows = await loadEventRows(tx, ctx.userId, start, end);
  const clashes = rows.filter((r) => occupiesTime(r) && !['work', 'morning_routine'].includes(r.kind));
  const week = weekStartOf(input.date);
  await lockWeek(tx, ctx.userId, week);
  const version = await createPlanVersion(tx, ctx.userId, week, { source: 'manual', summary: `Добавлено: ${input.title}`, localDate: input.date, actor });
  const row = one(await tx<EventRow[]>`
    insert into schedule_events (user_id, local_date, start_at, end_at, kind, title, priority_class, status, source, task_id, plan_version_id)
    values (${ctx.userId}, ${input.date}, ${start.toJSDate()}, ${end.toJSDate()}, ${input.kind}, ${input.title}, ${input.priorityClass},
            'planned', 'manual', ${input.taskId ?? null}, ${version.id})
    returning *`);
  await recordChange(tx, ctx.userId, version.id, { eventId: row.id, action: 'create', to: { startAt: start.toISO(), endAt: end.toISO() }, actor });
  if (input.taskId) {
    await tx`update tasks set status = 'scheduled', planned_at = ${start.toJSDate()} where id = ${input.taskId} and user_id = ${ctx.userId}`;
  }
  await reconcileReminders(tx, ctx, now, { eventIds: [row.id] });
  return {
    event: serializeEvent(row),
    warnings: clashes.map((c) => `Пересекается с «${c.title}» ${localTimeOf(c.startAt, ctx.tz)}–${localTimeOf(c.endAt, ctx.tz)}`),
  };
}

/**
 * Suggest the nearest free slot for a task on a date (after work on work days).
 * `opts` (optional) lets a caller reserve slots it already proposed (`extraBusy`, e.g. a multi-item
 * draft for tomorrow) and narrow the window (e.g. the gym window for a workout).
 */
export async function suggestTaskSlot(
  tx: Tx,
  ctx: UserContext,
  now: DateTime,
  date: LocalDate,
  durationMinutes: number,
  opts: { extraBusy?: { startAt: DateTime; endAt: DateTime; label?: string }[]; earliest?: string; latest?: string; preferredStart?: string } = {},
) {
  await ensureMaterialized(tx, ctx, now, date, date);
  const rows = (await loadEventRows(tx, ctx.userId, ...Object.values(dayBoundsUtc(date, ctx.tz)) as [DateTime, DateTime])).map(toPlanEvent);
  const isWork = ctx.prefs.workDays.includes(isoWeekday(date));
  const earliest = opts.earliest ?? (isWork ? ctx.prefs.workEnd : '10:00');
  const busy = busyForDay(date, ctx.tz, rows, opts.extraBusy ?? []);
  return findSlot({
    date,
    tz: ctx.tz,
    durationMinutes,
    earliest,
    latest: opts.latest ?? '23:00',
    preferredStart: opts.preferredStart ?? earliest,
    busy,
    notBefore: now,
    stepMinutes: 15,
  });
}
