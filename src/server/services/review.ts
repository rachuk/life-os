import type { DateTime } from 'luxon';
import { z } from 'zod';
import { addDays, isLocalDate, isLocalTime, localDateOf, localTimeOf, weekStartOf, zoned, type LocalDate } from '@/domain/time';
import { KIND_LABELS, MEAL_SLOT_LABELS, type EventKind, type MealSlot } from '@/domain/types';
import type { Tx } from '../db';
import { AppError } from '../http';
import { audit } from './audit';
import { upsertCheckin } from './habits';
import { addMeasurement } from './health';
import { createManualEvent, dayEvents, ensureMaterialized, serializeEvent, suggestTaskSlot, transitionEvent, type EventRow, type SerializedEvent } from './planning';
import type { UserContext } from './profile';
import { syncXp } from './rewards';

/**
 * Evening review + plan for tomorrow (PRD §13.3, §5.6).
 * - dayFacts: what the database knows about the day — confirmed / skipped / unknown, never guessed.
 * - 2–4 short questions; "Пропустить обзор сегодня" is always allowed.
 * - tomorrowDraft: tomorrow's events + suggestions with their source and a proposed free slot.
 *   Nothing is changed until the user accepts; no answer means the existing plan simply stays.
 */

const ANSWER_KINDS: EventKind[] = ['meal_breakfast', 'meal_lunch', 'meal_dinner', 'workout', 'own_project', 'task', 'extra_work', 'work', 'custom'];
const OPEN = new Set(['planned', 'notified', 'snoozed', 'unanswered', 'started']);
const MAIN: { slot: MealSlot; kind: EventKind }[] = [
  { slot: 'breakfast', kind: 'meal_breakfast' },
  { slot: 'lunch', kind: 'meal_lunch' },
  { slot: 'dinner', kind: 'meal_dinner' },
];
const minutesOf = (e: { startAt: Date; endAt: Date }) => Math.round((e.endAt.getTime() - e.startAt.getTime()) / 60000);

/** After midnight (until 05:00) the evening review still belongs to the previous day. */
export function defaultEveningDate(ctx: UserContext, now: DateTime): LocalDate {
  const local = now.setZone(ctx.tz);
  const today = local.toISODate()!;
  return local.hour < 5 ? addDays(today, -1) : today;
}

function assertReviewDate(date: string, ctx: UserContext, now: DateTime): LocalDate {
  if (!isLocalDate(date)) throw new AppError('BAD_DATE', 'Дата в формате ГГГГ-ММ-ДД', 422);
  const today = localDateOf(now, ctx.tz);
  if (date > today) throw new AppError('FUTURE_DATE', 'Обзор дня можно провести только за прошедший или текущий день', 422);
  if (date < addDays(today, -14)) throw new AppError('TOO_OLD', 'Слишком давний день для вечернего обзора', 422);
  return date;
}

// ---------------------------------------------------------------------------
// facts of the day
// ---------------------------------------------------------------------------
export type MealDayStatus = 'confirmed' | 'skipped' | 'unknown' | 'upcoming' | 'not_planned';

export interface DayFacts {
  date: LocalDate;
  events: { tracked: number; completed: number; skipped: number; unknown: number; upcoming: number; needsReschedule: number; cancelled: number };
  unanswered: SerializedEvent[];
  meals: { slot: MealSlot; label: string; status: MealDayStatus }[];
  extraWork: { plannedMinutes: number; actualMinutes: number; sessions: number };
  workout: { planned: number; completed: number; skipped: number; unknown: number; sessionLogged: boolean };
  habits: { id: string; key: string; name: string; status: string | null }[];
  review: { answers: EveningAnswers | null; reviewedAt: string | null; skipped: boolean };
}

export interface EveningAnswers {
  wins: string | null;
  blockers: string | null;
  workedInBed: boolean | null;
  energy: number | null;
}

export async function dayFacts(tx: Tx, ctx: UserContext, now: DateTime, date: LocalDate): Promise<DayFacts> {
  const rows = (await dayEvents(tx, ctx, date)).filter((r) => r.localDate === date);
  const nowJs = now.toJSDate();
  const tracked = rows.filter((r) => ANSWER_KINDS.includes(r.kind) || r.kind === 'snack');
  const count = (pred: (r: EventRow) => boolean) => tracked.filter(pred).length;
  const unanswered = rows.filter((r) => ANSWER_KINDS.includes(r.kind) && r.endAt <= nowJs && OPEN.has(r.status));

  const logs = await tx<{ mealSlot: MealSlot; consumptionStatus: string }[]>`
    select meal_slot, consumption_status from meal_logs where user_id = ${ctx.userId} and local_date = ${date}`;
  const meals = MAIN.map(({ slot, kind }) => {
    const evs = rows.filter((r) => r.kind === kind && r.status !== 'cancelled');
    const l = logs.filter((x) => x.mealSlot === slot);
    let status: MealDayStatus;
    if (evs.some((e) => e.status === 'completed') || l.some((x) => x.consumptionStatus !== 'not_eaten')) status = 'confirmed';
    else if (evs.some((e) => e.status === 'skipped') || l.some((x) => x.consumptionStatus === 'not_eaten')) status = 'skipped';
    else if (!evs.length) status = 'not_planned';
    else if (evs.every((e) => e.endAt > nowJs)) status = 'upcoming';
    else status = 'unknown';
    return { slot, label: MEAL_SLOT_LABELS[slot], status };
  });

  const extra = rows.filter((r) => r.kind === 'extra_work' && r.status !== 'cancelled');
  const workouts = rows.filter((r) => r.kind === 'workout' && r.status !== 'cancelled');
  const [ws] = await tx<{ n: number }[]>`
    select count(*)::int as n from workout_sessions where user_id = ${ctx.userId} and local_date = ${date} and status = 'completed'`;
  const habits = await tx<{ id: string; key: string; name: string; status: string | null }[]>`
    select h.id, h.key, h.name, c.status from habit_definitions h
    left join habit_checkins c on c.habit_id = h.id and c.local_date = ${date}
    where h.user_id = ${ctx.userId} and h.enabled and h.type = 'daily_rule' order by h.sort_order`;
  const [plan] = await tx<{ eveningReviewJson: EveningAnswers | null; eveningReviewedAt: Date | null; eveningReviewSkipped: boolean }[]>`
    select evening_review_json, evening_reviewed_at, evening_review_skipped from day_plans where user_id = ${ctx.userId} and local_date = ${date}`;

  return {
    date,
    events: {
      tracked: count((r) => r.status !== 'cancelled'),
      completed: count((r) => r.status === 'completed'),
      skipped: count((r) => r.status === 'skipped'),
      unknown: count((r) => OPEN.has(r.status) && r.endAt <= nowJs),
      upcoming: count((r) => OPEN.has(r.status) && r.endAt > nowJs),
      needsReschedule: count((r) => r.status === 'rescheduled'),
      cancelled: count((r) => r.status === 'cancelled'),
    },
    unanswered: unanswered.map(serializeEvent),
    meals,
    extraWork: {
      plannedMinutes: extra.reduce((s, e) => s + minutesOf(e), 0),
      actualMinutes: extra.filter((e) => e.status === 'completed').reduce((s, e) => s + (e.actualMinutes ?? minutesOf(e)), 0),
      sessions: extra.length,
    },
    workout: {
      planned: workouts.length,
      completed: workouts.filter((w) => w.status === 'completed').length,
      skipped: workouts.filter((w) => w.status === 'skipped').length,
      unknown: workouts.filter((w) => OPEN.has(w.status) && w.endAt <= nowJs).length,
      sessionLogged: (ws?.n ?? 0) > 0,
    },
    habits,
    review: {
      answers: plan?.eveningReviewJson ?? null,
      reviewedAt: plan?.eveningReviewedAt?.toISOString() ?? null,
      skipped: plan?.eveningReviewSkipped ?? false,
    },
  };
}

// ---------------------------------------------------------------------------
// the 2–4 questions
// ---------------------------------------------------------------------------
export const eveningReviewSchema = z.object({
  date: z.string().refine(isLocalDate, 'Дата ГГГГ-ММ-ДД'),
  wins: z.string().trim().max(500).nullable().optional(),
  blockers: z.string().trim().max(500).nullable().optional(),
  workedInBed: z.boolean().nullable().optional(),
  energy: z.number().int().min(1).max(5).nullable().optional(),
});
export type EveningReviewInput = z.infer<typeof eveningReviewSchema>;

async function upsertDayPlan(tx: Tx, userId: string, date: LocalDate, patch: { reviewJson?: EveningAnswers; reviewedAt?: Date; skipped?: boolean }) {
  await tx`
    insert into day_plans (user_id, local_date, evening_review_json, evening_reviewed_at, evening_review_skipped)
    values (${userId}, ${date}, ${patch.reviewJson ? tx.json(patch.reviewJson as never) : null}, ${patch.reviewedAt ?? null}, ${patch.skipped ?? false})
    on conflict (user_id, local_date) do update set
      evening_review_json = coalesce(excluded.evening_review_json, day_plans.evening_review_json),
      evening_reviewed_at = coalesce(excluded.evening_reviewed_at, day_plans.evening_reviewed_at),
      evening_review_skipped = ${patch.skipped ?? false}`;
}

export async function saveEveningReview(tx: Tx, ctx: UserContext, now: DateTime, input: EveningReviewInput) {
  const date = assertReviewDate(input.date, ctx, now);
  const answers: EveningAnswers = {
    wins: input.wins?.trim() || null,
    blockers: input.blockers?.trim() || null,
    workedInBed: input.workedInBed ?? null,
    energy: input.energy ?? null,
  };
  await upsertDayPlan(tx, ctx.userId, date, { reviewJson: answers, reviewedAt: now.toJSDate(), skipped: false });

  // «не работал в кровати?» is the evening check-in of the daily rule habit
  if (answers.workedInBed !== null) {
    const [h] = await tx<{ id: string }[]>`
      select id from habit_definitions where user_id = ${ctx.userId} and key = 'no_work_in_bed' and enabled`;
    if (h) {
      await upsertCheckin(
        tx,
        ctx.userId,
        { habitId: h.id, localDate: date, status: answers.workedInBed ? 'skipped' : 'done', reason: answers.workedInBed ? 'Работал в кровати' : null },
        'evening_review',
      );
    }
  }
  // "how tired" is the user's own answer → stored as the day's energy (1–5) with provenance
  if (answers.energy !== null) {
    await addMeasurement(tx, ctx, now, { metricType: 'energy', value: answers.energy, localDate: date, sourceType: 'manual', replace: true, notes: 'вечерний обзор' });
  }
  await audit(tx, ctx.userId, 'day_plan', date, 'evening_review_saved', {
    hasWins: !!answers.wins,
    hasBlockers: !!answers.blockers,
    workedInBed: answers.workedInBed,
    energy: answers.energy,
  });
  await syncXp(tx, ctx, now, weekStartOf(date));
  return { date, answers, message: 'День завершён. Спасибо!' };
}

export async function skipEveningReview(tx: Tx, ctx: UserContext, now: DateTime, dateInput: string) {
  const date = assertReviewDate(dateInput, ctx, now);
  await upsertDayPlan(tx, ctx.userId, date, { skipped: true });
  await audit(tx, ctx.userId, 'day_plan', date, 'evening_review_skipped', {});
  return { date, message: 'Обзор пропущен — завтрашний план остаётся как есть.' };
}

// ---------------------------------------------------------------------------
// tomorrow: draft with sources + proposed slots
// ---------------------------------------------------------------------------
export type SuggestionSource = 'due' | 'overdue' | 'follow_up' | 'carry_over' | 'weekly_quota';

export interface DraftSuggestion {
  id: string;
  source: SuggestionSource;
  sourceLabel: string;
  title: string;
  detail: string | null;
  kind: 'task' | 'workout' | 'own_project' | 'custom';
  durationMinutes: number;
  slot: { startTime: string; endTime: string } | null;
  selected: boolean;
}

interface SuggestionInternal extends DraftSuggestion {
  taskId: string | null;
  eventId: string | null;
  eventRevision: number | null;
}

const SOURCE_LABELS: Record<SuggestionSource, string> = {
  due: 'Срок завтра',
  overdue: 'Просрочено',
  follow_up: 'Проверить ответ',
  carry_over: 'Нужно перенести',
  weekly_quota: 'Недельная норма',
};

function assertDraftDate(date: string, ctx: UserContext, now: DateTime): LocalDate {
  if (!isLocalDate(date)) throw new AppError('BAD_DATE', 'Дата в формате ГГГГ-ММ-ДД', 422);
  const today = localDateOf(now, ctx.tz);
  if (date < today || date > addDays(today, 7)) throw new AppError('BAD_DATE', 'План можно собрать на ближайшие дни', 422);
  return date;
}

async function collectSuggestions(tx: Tx, ctx: UserContext, now: DateTime, date: LocalDate): Promise<SuggestionInternal[]> {
  const uid = ctx.userId;
  const out: SuggestionInternal[] = [];
  const dayEnd = zoned(addDays(date, 1), '00:00', ctx.tz).toJSDate();
  const nowJs = now.toJSDate();
  const mk = (s: Omit<SuggestionInternal, 'sourceLabel' | 'slot'>): SuggestionInternal => ({ ...s, sourceLabel: SOURCE_LABELS[s.source], slot: null });

  // tasks: due tomorrow / overdue / follow-ups — without an active future event already
  const tasks = await tx<{ id: string; title: string; type: string; status: string; priority: string; dueDate: string | null; followUpAt: Date | null; estimatedMinutes: number | null; waitingFor: string | null }[]>`
    select t.id, t.title, t.type, t.status, t.priority, t.due_date, t.follow_up_at, t.estimated_minutes, t.waiting_for
    from tasks t
    where t.user_id = ${uid}
      and (
        (t.status in ('inbox','todo','in_progress') and t.type in ('task','reminder') and t.due_date is not null
          and t.due_date <= ${date} and t.due_date >= ${addDays(date, -30)})
        or (t.status = 'waiting' and t.follow_up_at is not null and t.follow_up_at < ${dayEnd})
      )
      and not exists (
        select 1 from schedule_events e where e.task_id = t.id and e.user_id = ${uid}
          and e.status not in ('cancelled','skipped','completed','rescheduled') and e.end_at > ${nowJs})
    order by t.priority = 'high' desc, t.due_date nulls last, t.created_at
    limit 12`;
  for (const t of tasks) {
    const isFollow = t.status === 'waiting';
    const source: SuggestionSource = isFollow ? 'follow_up' : t.dueDate === date ? 'due' : 'overdue';
    out.push(
      mk({
        id: `task:${t.id}`,
        source,
        title: t.title,
        detail: isFollow ? (t.waitingFor ? `Ожидаю: ${t.waitingFor}` : null) : t.dueDate && t.dueDate !== date ? `Срок был ${t.dueDate.split('-').reverse().join('.')}` : null,
        kind: 'task',
        durationMinutes: isFollow ? 15 : Math.min(240, t.estimatedMinutes ?? 30),
        selected: true,
        taskId: t.id,
        eventId: null,
        eventRevision: null,
      }),
    );
  }

  // carried-over events marked "нужно перенести" during the last week (not meals or fixed blocks)
  const carry = await tx<EventRow[]>`
    select * from schedule_events
    where user_id = ${uid} and status = 'rescheduled' and local_date between ${addDays(date, -7)} and ${date}
      and kind in ('own_project','task','custom','workout')
    order by start_at limit 6`;
  for (const e of carry) {
    out.push(
      mk({
        id: `event:${e.id}`,
        source: 'carry_over',
        title: e.title,
        detail: `${KIND_LABELS[e.kind]} от ${e.localDate.split('-').reverse().join('.')}${e.reason ? ` · ${e.reason}` : ''}`,
        kind: e.kind === 'workout' ? 'workout' : e.kind === 'own_project' ? 'own_project' : e.kind === 'task' ? 'task' : 'custom',
        durationMinutes: Math.max(15, minutesOf(e)),
        selected: true,
        taskId: e.taskId,
        eventId: e.id,
        eventRevision: e.revision,
      }),
    );
  }

  // weekly quota: workouts (and own-project time) still missing in tomorrow's week
  const ws = weekStartOf(date);
  const we = addDays(ws, 6);
  const weekRows = await tx<{ kind: string; status: string; localDate: string; startAt: Date; endAt: Date; actualMinutes: number | null }[]>`
    select kind, status, local_date, start_at, end_at, actual_minutes from schedule_events
    where user_id = ${uid} and local_date between ${ws} and ${we} and kind in ('workout','own_project')`;
  const [manual] = await tx<{ n: number }[]>`
    select count(*)::int as n from workout_sessions
    where user_id = ${uid} and status = 'completed' and schedule_event_id is null and local_date between ${ws} and ${we}`;
  const ahead = (r: { status: string; endAt: Date }) => ['planned', 'notified', 'snoozed', 'started'].includes(r.status) && r.endAt > nowJs;
  const t = ctx.prefs.targets;
  const w = weekRows.filter((r) => r.kind === 'workout');
  const wDone = w.filter((r) => r.status === 'completed').length + (manual?.n ?? 0);
  const wAhead = w.filter(ahead).length;
  const carriedWorkouts = out.filter((s) => s.source === 'carry_over' && s.kind === 'workout').length;
  const wMissing = t.workouts - wDone - wAhead - carriedWorkouts;
  const tomorrowHasWorkout = w.some((r) => r.localDate === date && r.status !== 'cancelled' && r.status !== 'skipped');
  if (t.workouts > 0 && wMissing > 0 && !tomorrowHasWorkout) {
    out.push(
      mk({
        id: 'quota:workout',
        source: 'weekly_quota',
        title: 'Силовая тренировка',
        detail: `На неделе: выполнено ${wDone} из ${t.workouts}, впереди в плане ${wAhead}`,
        kind: 'workout',
        durationMinutes: t.workoutMinutes,
        selected: true,
        taskId: null,
        eventId: null,
        eventRevision: null,
      }),
    );
  }
  const p = weekRows.filter((r) => r.kind === 'own_project');
  const pDone = p.filter((r) => r.status === 'completed').reduce((s, r) => s + (r.actualMinutes ?? minutesOf(r)), 0);
  const pAhead = p.filter(ahead).reduce((s, r) => s + minutesOf(r), 0);
  const pMissing = t.projectMinutes - pDone - pAhead;
  const tomorrowHasProject = p.some((r) => r.localDate === date && ahead(r));
  if (t.projectMinutes > 0 && pMissing >= 30 && !tomorrowHasProject && !out.some((s) => s.source === 'carry_over' && s.kind === 'own_project')) {
    out.push(
      mk({
        id: 'quota:own_project',
        source: 'weekly_quota',
        title: 'Свой проект',
        detail: `На неделе: подтверждено ${pDone} мин из ${t.projectMinutes}, впереди ${pAhead} мин`,
        kind: 'own_project',
        durationMinutes: Math.min(t.projectSessionMinutes, Math.ceil(pMissing / 15) * 15),
        selected: false,
        taskId: null,
        eventId: null,
        eventRevision: null,
      }),
    );
  }
  return out.slice(0, 8);
}

function windowFor(ctx: UserContext, kind: DraftSuggestion['kind']) {
  const t = ctx.prefs.targets;
  if (kind === 'workout') return { earliest: t.gymFlexEarliest, latest: t.gymFlexLatest, preferredStart: ctx.prefs.gymStart };
  if (kind === 'own_project') return { earliest: t.projectEarliest, latest: t.projectLatest, preferredStart: t.projectPreferredStart };
  return {};
}

export interface TomorrowDraft {
  date: LocalDate;
  status: 'draft' | 'confirmed' | 'kept';
  confirmedAt: string | null;
  events: SerializedEvent[];
  suggestions: DraftSuggestion[];
}

export async function tomorrowDraft(tx: Tx, ctx: UserContext, now: DateTime, dateInput: string): Promise<TomorrowDraft> {
  const date = assertDraftDate(dateInput, ctx, now);
  await ensureMaterialized(tx, ctx, now, date, date);
  const internal = await collectSuggestions(tx, ctx, now, date);
  // slots are proposed one after another so the draft never double-books itself
  const reserved: { startAt: DateTime; endAt: DateTime; label: string }[] = [];
  for (const s of internal) {
    const slot = await suggestTaskSlot(tx, ctx, now, date, s.durationMinutes, { ...windowFor(ctx, s.kind), extraBusy: reserved });
    if (slot) {
      reserved.push({ ...slot, label: s.title });
      s.slot = { startTime: localTimeOf(slot.startAt, ctx.tz), endTime: localTimeOf(slot.endAt, ctx.tz) };
    }
  }
  const [plan] = await tx<{ status: TomorrowDraft['status']; confirmedAt: Date | null }[]>`
    select status, confirmed_at from day_plans where user_id = ${ctx.userId} and local_date = ${date}`;
  const events = (await dayEvents(tx, ctx, date)).filter((r) => r.kind !== 'sleep' || r.localDate === date);
  return {
    date,
    status: plan?.status ?? 'draft',
    confirmedAt: plan?.confirmedAt?.toISOString() ?? null,
    events: events.map(serializeEvent),
    suggestions: internal.map(({ taskId: _t, eventId: _e, eventRevision: _r, ...pub }) => pub),
  };
}

const hhmm = z.string().refine(isLocalTime, 'Время ЧЧ:ММ');
export const acceptTomorrowSchema = z.object({
  date: z.string().refine(isLocalDate, 'Дата ГГГГ-ММ-ДД'),
  items: z.array(z.object({ id: z.string().min(1).max(80), startTime: hhmm, durationMinutes: z.number().int().min(5).max(480) })).max(20),
  confirmDay: z.boolean().default(true),
});
export type AcceptTomorrowInput = z.infer<typeof acceptTomorrowSchema>;

async function setDayStatus(tx: Tx, userId: string, date: LocalDate, status: 'confirmed' | 'kept', now: DateTime) {
  await tx`
    insert into day_plans (user_id, local_date, status, confirmed_at) values (${userId}, ${date}, ${status}, ${now.toJSDate()})
    on conflict (user_id, local_date) do update set
      status = case when day_plans.status = 'confirmed' then 'confirmed' else excluded.status end,
      confirmed_at = coalesce(day_plans.confirmed_at, excluded.confirmed_at)`;
}

/**
 * «Принять всё» / one edited item. Suggestions are re-read on the server (client titles are not
 * trusted); an item that is no longer suggested (already scheduled — double tap) is skipped.
 */
export async function acceptTomorrow(tx: Tx, ctx: UserContext, now: DateTime, input: AcceptTomorrowInput) {
  const date = assertDraftDate(input.date, ctx, now);
  const byId = new Map((await collectSuggestions(tx, ctx, now, date)).map((s) => [s.id, s]));
  const created: string[] = [];
  const skipped: string[] = [];
  const warnings: string[] = [];
  for (const item of input.items) {
    const s = byId.get(item.id);
    if (!s) {
      skipped.push(item.id);
      continue;
    }
    if (s.eventId) {
      const r = await transitionEvent(
        tx,
        ctx,
        now,
        s.eventId,
        { action: 'reschedule', toDate: date, toTime: item.startTime, reason: 'План на завтра', expectedRevision: s.eventRevision ?? undefined },
        'web',
      );
      warnings.push(...r.warnings);
      created.push(s.eventId);
    } else {
      const r = await createManualEvent(tx, ctx, now, {
        date,
        startTime: item.startTime,
        durationMinutes: item.durationMinutes,
        title: s.title,
        kind: s.kind,
        priorityClass: s.kind === 'workout' ? 'required_movable' : 'flexible',
        taskId: s.taskId,
      });
      // a follow-up stays "waiting" — the event is only the time to check the answer
      if (s.source === 'follow_up' && s.taskId) await tx`update tasks set status = 'waiting' where id = ${s.taskId} and user_id = ${ctx.userId}`;
      warnings.push(...r.warnings);
      created.push(r.event.id);
    }
    byId.delete(item.id);
  }
  if (input.confirmDay) await setDayStatus(tx, ctx.userId, date, 'confirmed', now);
  await audit(tx, ctx.userId, 'day_plan', date, input.confirmDay ? 'tomorrow_accepted' : 'tomorrow_item_added', { items: created.length, skipped: skipped.length });
  return {
    date,
    created: created.length,
    skipped,
    warnings: [...new Set(warnings)],
    message: created.length ? `План на завтра принят: добавлено ${created.length}` : input.confirmDay ? 'План на завтра подтверждён' : 'Уже в плане',
  };
}

export async function keepTomorrow(tx: Tx, ctx: UserContext, now: DateTime, dateInput: string) {
  const date = assertDraftDate(dateInput, ctx, now);
  await setDayStatus(tx, ctx.userId, date, 'kept', now);
  await audit(tx, ctx.userId, 'day_plan', date, 'tomorrow_kept', {});
  return { date, message: 'План на завтра оставлен без изменений' };
}

/** Everything the evening page needs. */
export async function eveningView(tx: Tx, ctx: UserContext, now: DateTime, dateParam?: string | null) {
  const date = dateParam && isLocalDate(dateParam) ? assertReviewDate(dateParam, ctx, now) : defaultEveningDate(ctx, now);
  const facts = await dayFacts(tx, ctx, now, date);
  const tomorrow = await tomorrowDraft(tx, ctx, now, addDays(date, 1) < localDateOf(now, ctx.tz) ? localDateOf(now, ctx.tz) : addDays(date, 1));
  return {
    date,
    today: localDateOf(now, ctx.tz),
    facts,
    tomorrow,
    askWorkInBed: facts.habits.some((h) => h.key === 'no_work_in_bed'),
  };
}
export type EveningView = Awaited<ReturnType<typeof eveningView>>;
