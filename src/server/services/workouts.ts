import type { DateTime } from 'luxon';
import { z } from 'zod';
import { DEFAULT_WORKOUT_PLAN, EXERCISE_BY_KEY, type Routine } from '@/domain/fitness/catalog';
import {
  exerciseUnit,
  nextRoutineKey,
  parseRoutines,
  prefillSet,
  progressionOffer,
  resolveRoutine,
  routineChoices,
  targetFor,
  type ProgressionOffer,
  type SetLike,
} from '@/domain/fitness/session';
import { addDays, isLocalDate, localDateOf, weekStartOf, zoned } from '@/domain/time';
import { isUuid, one, type Tx } from '../db';
import { AppError, notFound } from '../http';
import { audit } from './audit';
import { ensureMaterialized, getEventRow, loadEventRows, serializeEvent, transitionEvent, weekProgress, type EventRow } from './planning';
import type { UserContext } from './profile';

/**
 * Workout log (PRD §10): sessions A/B/«всё тело», sets, finish with effort, quick «Тренировка
 * состоялась», and progression suggestions that the user accepts or dismisses. A session linked to
 * a planned workout event drives that event planned → started → completed; weekly progress
 * (planning.weekProgress) counts completed workout events + completed sessions without an event.
 */

export interface SessionRow {
  id: string;
  planId: string | null;
  scheduleEventId: string | null;
  routineKey: string | null;
  localDate: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMinutes: number | null;
  status: 'planned' | 'started' | 'completed' | 'cancelled';
  perceivedEffort: number | null;
  notes: string | null;
  createdAt: Date;
}

export interface SetRow {
  id: string;
  sessionId: string;
  exerciseKey: string;
  setOrder: number;
  targetReps: number | null;
  actualReps: number | null;
  weightKg: number | null;
  rpe: number | null;
  completedAt: Date | null;
  createdAt: Date;
}

export const QUICK_ROUTINE_KEY = 'quick';

const setNotFound = () => new AppError('NOT_FOUND', 'Подход не найден', 404);

export function serializeSession(s: SessionRow) {
  return {
    ...s,
    startedAt: s.startedAt?.toISOString() ?? null,
    finishedAt: s.finishedAt?.toISOString() ?? null,
    createdAt: s.createdAt.toISOString(),
  };
}
export type SerializedSession = ReturnType<typeof serializeSession>;

export function serializeSet(s: SetRow) {
  return { ...s, completedAt: s.completedAt?.toISOString() ?? null, createdAt: s.createdAt.toISOString() };
}
export type SerializedSet = ReturnType<typeof serializeSet>;

// ---------------------------------------------------------------------------
// plan
// ---------------------------------------------------------------------------
export interface ActivePlan {
  id: string | null;
  name: string;
  daysPerWeek: number;
  notes: string | null;
  routines: Routine[];
}

export async function getActivePlan(tx: Tx, ctx: UserContext): Promise<ActivePlan> {
  const [p] = await tx<{ id: string; name: string; daysPerWeek: number; notes: string | null; routinesJson: unknown }[]>`
    select id, name, days_per_week, notes, routines_json from workout_plans
    where user_id = ${ctx.userId} and status = 'active' order by created_at desc limit 1`;
  if (!p) {
    // not persisted on read; onboarding seeds the real plan
    return { id: null, name: DEFAULT_WORKOUT_PLAN.name, daysPerWeek: ctx.prefs.targets.workouts, notes: DEFAULT_WORKOUT_PLAN.notes, routines: DEFAULT_WORKOUT_PLAN.routines };
  }
  return { id: p.id, name: p.name, daysPerWeek: p.daysPerWeek, notes: p.notes, routines: parseRoutines(p.routinesJson) };
}

export async function listPlans(tx: Tx, ctx: UserContext) {
  const rows = await tx<{ id: string; name: string; daysPerWeek: number; status: string; notes: string | null; routinesJson: unknown }[]>`
    select id, name, days_per_week, status, notes, routines_json from workout_plans where user_id = ${ctx.userId} order by created_at desc`;
  return rows.map((r) => ({ id: r.id, name: r.name, daysPerWeek: r.daysPerWeek, status: r.status, notes: r.notes, routines: routineChoices(parseRoutines(r.routinesJson)) }));
}

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
async function getSession(tx: Tx, userId: string, id: string, lock = false): Promise<SessionRow> {
  if (!isUuid(id)) throw notFound('Тренировка');
  const rows = lock
    ? await tx<SessionRow[]>`select * from workout_sessions where id = ${id} and user_id = ${userId} for update`
    : await tx<SessionRow[]>`select * from workout_sessions where id = ${id} and user_id = ${userId}`;
  if (!rows[0]) throw notFound('Тренировка');
  return rows[0];
}

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505';
}

async function workoutEvent(tx: Tx, userId: string, eventId: string): Promise<EventRow> {
  const ev = await getEventRow(tx, userId, eventId);
  if (ev.kind !== 'workout') throw new AppError('NOT_WORKOUT', 'Это событие не тренировка', 422);
  return ev;
}

/** Bring a linked event to "completed" — reopening a skipped/cancelled one first, because it did happen. */
async function completeLinkedEvent(tx: Tx, ctx: UserContext, now: DateTime, eventId: string, minutes: number | null, warnings: string[]) {
  const [ev] = await tx<{ status: string }[]>`select status from schedule_events where id = ${eventId} and user_id = ${ctx.userId}`;
  if (!ev || ev.status === 'completed') return;
  if (ev.status === 'skipped' || ev.status === 'cancelled') {
    await transitionEvent(tx, ctx, now, eventId, { action: 'reopen' }, 'web');
    warnings.push('Тренировка была отмечена пропущенной — отметка исправлена на «выполнено».');
  }
  const r = await transitionEvent(tx, ctx, now, eventId, { action: 'complete', actualMinutes: minutes }, 'web');
  warnings.push(...r.warnings);
}

export const startSessionSchema = z.object({
  routineKey: z.string().trim().min(1).max(20),
  eventId: z.string().uuid().nullable().optional(),
});

export async function startSession(tx: Tx, ctx: UserContext, now: DateTime, input: z.infer<typeof startSessionSchema>) {
  const plan = await getActivePlan(tx, ctx);
  const routine = resolveRoutine(plan.routines, input.routineKey);
  if (!routine) throw new AppError('UNKNOWN_ROUTINE', 'Такой программы нет — выбери A, B или «Всё тело»', 422);
  const eventId = input.eventId ?? null;

  const [active] = await tx<SessionRow[]>`select * from workout_sessions where user_id = ${ctx.userId} and status = 'started' for update`;
  if (active) {
    // a repeated tap on the same start is answered with the running session
    if (active.routineKey === routine.key && active.scheduleEventId === eventId) return { session: serializeSession(active), resumed: true, warnings: [] as string[] };
    throw new AppError('SESSION_ACTIVE', 'Уже идёт другая тренировка — заверши или отмени её', 409, { sessionId: active.id });
  }

  const warnings: string[] = [];
  if (eventId) {
    const ev = await workoutEvent(tx, ctx.userId, eventId);
    if (ev.status === 'completed') throw new AppError('ALREADY_DONE', 'Эта тренировка уже отмечена выполненной', 409);
    if (ev.status === 'skipped' || ev.status === 'cancelled') {
      throw new AppError('EVENT_SETTLED', 'Эта тренировка отмечена пропущенной или отменённой. Сними отметку в плане или начни без привязки.', 409);
    }
    const [dup] = await tx<{ id: string }[]>`
      select id from workout_sessions where schedule_event_id = ${eventId} and user_id = ${ctx.userId} and status in ('started','completed')`;
    if (dup) throw new AppError('ALREADY_LOGGED', 'Для этой тренировки уже есть запись', 409, { sessionId: dup.id });
    const r = await transitionEvent(tx, ctx, now, eventId, { action: 'start' }, 'web');
    warnings.push(...r.warnings);
  }

  let session: SessionRow;
  try {
    session = one(await tx<SessionRow[]>`
      insert into workout_sessions (user_id, plan_id, schedule_event_id, routine_key, local_date, started_at, status)
      values (${ctx.userId}, ${plan.id}, ${eventId}, ${routine.key}, ${localDateOf(now, ctx.tz)}, ${now.toJSDate()}, 'started')
      returning *`);
  } catch (e) {
    if (isUniqueViolation(e)) throw new AppError('SESSION_ACTIVE', 'Тренировка уже начата — обнови экран', 409);
    throw e;
  }
  await audit(tx, ctx.userId, 'workout_session', session.id, 'started', { routine: routine.key, linked: !!eventId });
  return { session: serializeSession(session), resumed: false, warnings };
}

export const setInputSchema = z.object({
  setId: z.string().uuid().optional(),
  exerciseKey: z.string().refine((k) => !!EXERCISE_BY_KEY[k], 'Неизвестное упражнение'),
  actualReps: z.number().int().min(0).max(1000).nullable(),
  weightKg: z.number().min(0).max(500).nullable().optional(),
  rpe: z.number().min(1).max(10).nullable().optional(),
  targetReps: z.number().int().min(0).max(1000).nullable().optional(),
});

export async function upsertSet(tx: Tx, ctx: UserContext, now: DateTime, sessionId: string, input: z.infer<typeof setInputSchema>) {
  const s = await getSession(tx, ctx.userId, sessionId, true);
  if (s.status === 'cancelled') throw new AppError('SESSION_CANCELLED', 'Эта тренировка отменена', 409);
  const weight = input.weightKg === undefined || input.weightKg === null ? null : Math.round(input.weightKg * 100) / 100;
  const rpe = input.rpe === undefined || input.rpe === null ? null : Math.round(input.rpe * 2) / 2;
  if (input.setId) {
    const rows = await tx<SetRow[]>`
      update workout_sets set actual_reps = ${input.actualReps}, weight_kg = ${weight}, rpe = ${rpe},
        target_reps = coalesce(${input.targetReps ?? null}::int, target_reps)
      where id = ${input.setId} and session_id = ${s.id} and user_id = ${ctx.userId} returning *`;
    if (!rows[0]) throw setNotFound();
    return serializeSet(rows[0]);
  }
  const [{ n } = { n: 0 }] = await tx<{ n: number }[]>`
    select coalesce(max(set_order), 0)::int as n from workout_sets where session_id = ${s.id} and exercise_key = ${input.exerciseKey}`;
  const row = one(await tx<SetRow[]>`
    insert into workout_sets (user_id, session_id, exercise_key, set_order, target_reps, actual_reps, weight_kg, rpe, completed_at)
    values (${ctx.userId}, ${s.id}, ${input.exerciseKey}, ${n + 1}, ${input.targetReps ?? null}, ${input.actualReps}, ${weight}, ${rpe}, ${now.toJSDate()})
    returning *`);
  return serializeSet(row);
}

export async function deleteSet(tx: Tx, userId: string, setId: string) {
  if (!isUuid(setId)) throw setNotFound();
  const rows = await tx`delete from workout_sets where id = ${setId} and user_id = ${userId} returning id`;
  if (!rows.length) throw setNotFound();
}

export const finishSchema = z.object({
  durationMinutes: z.number().int().min(1).max(600).nullable().optional(),
  perceivedEffort: z.number().int().min(1).max(10).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

export async function finishSession(tx: Tx, ctx: UserContext, now: DateTime, sessionId: string, input: z.infer<typeof finishSchema>) {
  const s = await getSession(tx, ctx.userId, sessionId, true);
  if (s.status === 'completed') return { session: serializeSession(s), changed: false, warnings: [] as string[] };
  if (s.status !== 'started') throw new AppError('NOT_STARTED', 'Эта тренировка не идёт сейчас', 409);
  const elapsed = s.startedAt ? Math.max(1, Math.round((now.toMillis() - s.startedAt.getTime()) / 60000)) : null;
  const duration = input.durationMinutes ?? (elapsed !== null ? Math.min(elapsed, 600) : null);
  const updated = one(await tx<SessionRow[]>`
    update workout_sessions set status = 'completed', finished_at = ${now.toJSDate()}, duration_minutes = ${duration},
      perceived_effort = ${input.perceivedEffort ?? null}, notes = ${input.notes?.trim() || null}
    where id = ${s.id} returning *`);
  const warnings: string[] = [];
  if (s.scheduleEventId) await completeLinkedEvent(tx, ctx, now, s.scheduleEventId, duration, warnings);
  await audit(tx, ctx.userId, 'workout_session', s.id, 'completed', { minutes: duration, effort: input.perceivedEffort ?? null });
  return { session: serializeSession(updated), changed: true, warnings };
}

/** Abandon a session started by mistake: nothing counts, a started event goes back to planned. */
export async function cancelSession(tx: Tx, ctx: UserContext, now: DateTime, sessionId: string) {
  const s = await getSession(tx, ctx.userId, sessionId, true);
  if (s.status !== 'started') throw new AppError('NOT_STARTED', 'Отменить можно только идущую тренировку', 409);
  await tx`update workout_sessions set status = 'cancelled', finished_at = ${now.toJSDate()} where id = ${s.id}`;
  if (s.scheduleEventId) {
    const [ev] = await tx<{ status: string }[]>`select status from schedule_events where id = ${s.scheduleEventId} and user_id = ${ctx.userId}`;
    if (ev?.status === 'started') await transitionEvent(tx, ctx, now, s.scheduleEventId, { action: 'reopen' }, 'web');
  }
  await audit(tx, ctx.userId, 'workout_session', s.id, 'cancelled', {});
}

export const quickLogSchema = z.object({
  durationMinutes: z.number().int().min(5).max(600),
  eventId: z.string().uuid().nullable().optional(),
  localDate: z.string().refine(isLocalDate).optional(),
  perceivedEffort: z.number().int().min(1).max(10).nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

/**
 * «Тренировка состоялась» + duration, without sets (PRD §10.2). Counts toward the weekly target:
 * a linked event becomes completed, an unlinked session counts on its own.
 */
export async function quickLog(tx: Tx, ctx: UserContext, now: DateTime, input: z.infer<typeof quickLogSchema>) {
  const today = localDateOf(now, ctx.tz);
  const eventId = input.eventId ?? null;
  let localDate = input.localDate ?? today;
  if (localDate > today) throw new AppError('FUTURE_DATE', 'Нельзя отметить тренировку в будущем', 422);
  if (localDate < addDays(today, -14)) throw new AppError('TOO_OLD', 'Отметить можно тренировки за последние две недели', 422);
  const warnings: string[] = [];

  if (eventId) {
    const ev = await workoutEvent(tx, ctx.userId, eventId);
    const [existing] = await tx<SessionRow[]>`
      select * from workout_sessions where schedule_event_id = ${eventId} and user_id = ${ctx.userId} and status in ('started','completed') for update`;
    if (existing?.status === 'completed') return { session: serializeSession(existing), changed: false, warnings };
    if (existing?.status === 'started') {
      return finishSession(tx, ctx, now, existing.id, { durationMinutes: input.durationMinutes, perceivedEffort: input.perceivedEffort, notes: input.notes });
    }
    if (input.localDate === undefined) localDate = ev.localDate <= today ? ev.localDate : today;
  }

  const finishedAt = localDate === today ? now : zoned(localDate, '21:00', ctx.tz);
  const plan = await getActivePlan(tx, ctx);
  const session = one(await tx<SessionRow[]>`
    insert into workout_sessions (user_id, plan_id, schedule_event_id, routine_key, local_date, started_at, finished_at, duration_minutes, status, perceived_effort, notes)
    values (${ctx.userId}, ${plan.id}, ${eventId}, ${QUICK_ROUTINE_KEY}, ${localDate}, ${finishedAt.minus({ minutes: input.durationMinutes }).toJSDate()},
            ${finishedAt.toJSDate()}, ${input.durationMinutes}, 'completed', ${input.perceivedEffort ?? null}, ${input.notes?.trim() || null})
    returning *`);
  if (eventId) await completeLinkedEvent(tx, ctx, now, eventId, input.durationMinutes, warnings);
  await audit(tx, ctx.userId, 'workout_session', session.id, 'quick_logged', { minutes: input.durationMinutes, linked: !!eventId });
  return { session: serializeSession(session), changed: true, warnings };
}

// ---------------------------------------------------------------------------
// progression decisions (suggestion only, PRD §10.3)
// ---------------------------------------------------------------------------
export const progressionDecisionSchema = z.object({
  exerciseKey: z.string().refine((k) => !!EXERCISE_BY_KEY[k], 'Неизвестное упражнение'),
  basedOnSessionId: z.string().uuid(),
  decision: z.enum(['accepted', 'dismissed']),
  weightKg: z.number().min(0).max(500).nullable().optional(),
});

export async function decideProgression(tx: Tx, userId: string, input: z.infer<typeof progressionDecisionSchema>) {
  const s = await getSession(tx, userId, input.basedOnSessionId);
  if (s.status !== 'completed') throw new AppError('NOT_COMPLETED', 'Рекомендация строится только по завершённой тренировке', 409);
  await tx`
    insert into workout_progression_decisions (user_id, exercise_key, based_on_session_id, decision, suggested_weight_kg)
    values (${userId}, ${input.exerciseKey}, ${s.id}, ${input.decision}, ${input.decision === 'accepted' ? (input.weightKg ?? null) : null})
    on conflict (user_id, exercise_key, based_on_session_id)
    do update set decision = excluded.decision, suggested_weight_kg = excluded.suggested_weight_kg`;
  await audit(tx, userId, 'workout_progression', s.id, input.decision, { exercise: input.exerciseKey });
}

// ---------------------------------------------------------------------------
// views
// ---------------------------------------------------------------------------
export async function sessionHistory(tx: Tx, userId: string, limit = 20) {
  const sessions = await tx<SessionRow[]>`
    select * from workout_sessions where user_id = ${userId} and status = 'completed'
    order by local_date desc, finished_at desc nulls last limit ${Math.min(Math.max(limit, 1), 100)}`;
  const sets = sessions.length
    ? await tx<SetRow[]>`select * from workout_sets where session_id = any(${sessions.map((s) => s.id)}) order by exercise_key, set_order`
    : [];
  return sessions.map((s) => {
    const own = sets.filter((x) => x.sessionId === s.id);
    return {
      ...serializeSession(s),
      quick: s.routineKey === QUICK_ROUTINE_KEY,
      setCount: own.length,
      exercises: [...new Set(own.map((x) => x.exerciseKey))],
      sets: own.map(serializeSet),
    };
  });
}

interface PreviousBlock {
  sessionId: string;
  localDate: string;
  routineKey: string | null;
  sets: SetLike[];
}

async function previousByExercise(tx: Tx, userId: string, excludeSessionId: string | null): Promise<Map<string, PreviousBlock>> {
  const latest = await tx<{ exerciseKey: string; sessionId: string; localDate: string; routineKey: string | null }[]>`
    select distinct on (st.exercise_key) st.exercise_key, s.id as session_id, s.local_date, s.routine_key
    from workout_sets st join workout_sessions s on s.id = st.session_id
    where s.user_id = ${userId} and s.status = 'completed' and (${excludeSessionId}::uuid is null or s.id <> ${excludeSessionId}::uuid)
    order by st.exercise_key, s.local_date desc, s.finished_at desc nulls last`;
  const out = new Map<string, PreviousBlock>();
  if (!latest.length) return out;
  const sets = await tx<SetRow[]>`
    select * from workout_sets where session_id = any(${[...new Set(latest.map((l) => l.sessionId))]}) order by set_order`;
  for (const l of latest) {
    out.set(l.exerciseKey, {
      sessionId: l.sessionId,
      localDate: l.localDate,
      routineKey: l.routineKey,
      sets: sets.filter((s) => s.sessionId === l.sessionId && s.exerciseKey === l.exerciseKey),
    });
  }
  return out;
}

export interface ExerciseView {
  exerciseKey: string;
  unit: 'reps' | 'seconds';
  target: { sets: number; repsMin: number; repsMax: number } | null;
  previous: { sessionId: string; localDate: string; sets: { setOrder: number; actualReps: number | null; weightKg: number | null; rpe: number | null }[] } | null;
  prefill: { reps: number | null; weightKg: number | null };
  acceptedWeightKg: number | null;
  offer: ProgressionOffer | null;
}

export async function workoutOverview(tx: Tx, ctx: UserContext, now: DateTime, opts: { eventId?: string | null } = {}) {
  const today = localDateOf(now, ctx.tz);
  const weekStart = weekStartOf(today);
  await ensureMaterialized(tx, ctx, now, today, addDays(weekStart, 6));
  const plan = await getActivePlan(tx, ctx);
  const progress = (await weekProgress(tx, ctx, weekStart)).workouts;
  const weekRows = (await loadEventRows(tx, ctx.userId, zoned(weekStart, '00:00', ctx.tz), zoned(addDays(weekStart, 7), '00:00', ctx.tz))).filter(
    (r) => r.kind === 'workout' && r.localDate >= weekStart && r.localDate <= addDays(weekStart, 6),
  );

  let event: ReturnType<typeof serializeEvent> | null = null;
  let eventMissing = false;
  if (opts.eventId) {
    const [ev] = isUuid(opts.eventId)
      ? await tx<EventRow[]>`select * from schedule_events where id = ${opts.eventId} and user_id = ${ctx.userId} and kind = 'workout'`
      : [];
    if (ev) event = serializeEvent(ev);
    else eventMissing = true;
  }

  const [active] = await tx<SessionRow[]>`select * from workout_sessions where user_id = ${ctx.userId} and status = 'started' limit 1`;
  const activeSets = active ? await tx<SetRow[]>`select * from workout_sets where session_id = ${active.id} order by exercise_key, set_order` : [];
  const [eventSession] = event
    ? await tx<SessionRow[]>`select * from workout_sessions where schedule_event_id = ${event.id} and user_id = ${ctx.userId} and status in ('started','completed') limit 1`
    : [];

  const previous = await previousByExercise(tx, ctx.userId, active?.id ?? null);
  const decisions = await tx<{ exerciseKey: string; basedOnSessionId: string; decision: string; suggestedWeightKg: number | null }[]>`
    select exercise_key, based_on_session_id, decision, suggested_weight_kg from workout_progression_decisions where user_id = ${ctx.userId}`;
  const decisionFor = (exerciseKey: string, sessionId: string) => decisions.find((d) => d.exerciseKey === exerciseKey && d.basedOnSessionId === sessionId);

  const exerciseKeys = new Set<string>();
  for (const r of routineChoices(plan.routines)) for (const e of r.exercises) exerciseKeys.add(e.exerciseKey);
  for (const s of activeSets) exerciseKeys.add(s.exerciseKey);

  const exercises: Record<string, ExerciseView> = {};
  for (const key of exerciseKeys) {
    const prev = previous.get(key) ?? null;
    const target = targetFor(key, plan.routines, active?.routineKey ?? prev?.routineKey ?? null);
    const prevTarget = prev ? targetFor(key, plan.routines, prev.routineKey) : null;
    const decision = prev ? decisionFor(key, prev.sessionId) : undefined;
    const accepted = decision?.decision === 'accepted' ? (decision.suggestedWeightKg ?? null) : null;
    exercises[key] = {
      exerciseKey: key,
      unit: exerciseUnit(key, target),
      target: target ? { sets: target.sets, repsMin: target.repsMin, repsMax: target.repsMax } : null,
      previous: prev
        ? { sessionId: prev.sessionId, localDate: prev.localDate, sets: prev.sets.map((s) => ({ setOrder: s.setOrder, actualReps: s.actualReps, weightKg: s.weightKg, rpe: s.rpe })) }
        : null,
      prefill: prefillSet(
        activeSets.filter((s) => s.exerciseKey === key),
        prev?.sets ?? [],
        target,
        accepted,
      ),
      acceptedWeightKg: accepted,
      offer: prev ? progressionOffer(key, prev.sessionId, prev.sets, prevTarget, !!decision) : null,
    };
  }

  const [lastDone] = await tx<{ routineKey: string | null }[]>`
    select routine_key from workout_sessions where user_id = ${ctx.userId} and status = 'completed' and routine_key is not null and routine_key <> ${QUICK_ROUTINE_KEY}
    order by local_date desc, finished_at desc nulls last limit 1`;

  return {
    today,
    weekStart,
    plan: { ...plan, choices: routineChoices(plan.routines) },
    suggestedRoutineKey: nextRoutineKey(plan.routines, lastDone?.routineKey ?? null),
    progress,
    weekEvents: weekRows.map(serializeEvent),
    event,
    eventMissing,
    eventSession: eventSession ? serializeSession(eventSession) : null,
    active: active ? { ...serializeSession(active), sets: activeSets.map(serializeSet) } : null,
    exercises,
    history: await sessionHistory(tx, ctx.userId, 12),
  };
}
export type WorkoutOverview = Awaited<ReturnType<typeof workoutOverview>>;
