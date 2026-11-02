import type { DateTime } from 'luxon';
import { z } from 'zod';
import {
  eveningReviewTime,
  parseMealWindows,
  parseNotificationPrefs,
  parseWeeklyTargets,
  type NotificationPrefs,
} from '@/domain/planner/prefs';
import {
  addDays,
  formatDateRu,
  isLocalDate,
  isoWeekday,
  localDateOf,
  localTimeOf,
  minutesToTime,
  timeToMinutes,
  weekBoundsUtc,
  weekDates,
  weekStartOf,
  weekdayShort,
  type LocalDate,
} from '@/domain/time';
import { KIND_LABELS, type EventKind } from '@/domain/types';
import { aiProvider, AIError } from '../ai/provider';
import { assertAIBudget, recordAIUsage } from '../ai/budget';
import { withUser, type Tx } from '../db';
import { env } from '../env';
import { AppError } from '../http';
import { audit } from './audit';
import { reconcileReminders } from './notifications';
import { regenerateFuture } from './planning';
import { loadContext, syncTemplates, type UserContext } from './profile';
import { grantXp, proposeWeekRewards, rewardsEnabled, syncXp, weekRewards } from './rewards';

/**
 * Weekly review (PRD §13.4–13.5, §20, §21.5). Facts are computed by SQL for the LOCAL week
 * Mon–Sun in the user's zone (REV-01). "No data" is reported as such, never as zero (REV-02).
 * Patterns and proposals are deterministic rules, each tied to the fact it is based on.
 * Proposals are only applied by an explicit decision, atomically (REV-03). AI may only comment
 * on aggregated facts and never changes data.
 */

// ---------------------------------------------------------------------------
// facts
// ---------------------------------------------------------------------------
const TRACKED: EventKind[] = ['meal_breakfast', 'meal_lunch', 'meal_dinner', 'snack', 'workout', 'own_project', 'task', 'extra_work', 'work', 'custom'];
const OPEN = new Set(['planned', 'notified', 'snoozed', 'unanswered']);
const MAIN_MEALS = [
  { slot: 'breakfast', kind: 'meal_breakfast', label: 'Завтрак' },
  { slot: 'lunch', kind: 'meal_lunch', label: 'Обед' },
  { slot: 'dinner', kind: 'meal_dinner', label: 'Ужин' },
] as const;
/** Standard reason chips (the only free-text-free reasons that may go to an AI provider). */
const STANDARD_REASONS = new Set(['Нет времени', 'Созвон', 'Устал', 'Плохо себя чувствую', 'Изменились планы', 'План на завтра']);

export interface KindStat {
  kind: EventKind;
  label: string;
  planned: number;
  completed: number;
  skipped: number;
  unknown: number;
  started: number;
  needsReschedule: number;
  upcoming: number;
  cancelled: number;
}

export interface WeekFacts {
  weekStart: LocalDate;
  weekEnd: LocalDate;
  tz: string;
  generatedAt: string;
  isComplete: boolean;
  daysElapsed: number;
  events: { total: Omit<KindStat, 'kind' | 'label'>; byKind: KindStat[] };
  meals: {
    slots: { slot: string; label: string; plannedDays: number; confirmedDays: number; skippedDays: number; unknownDays: number }[];
    confirmedBreakfastDays: number;
    daysWithAllMain: number;
    snacksConfirmed: number;
    anyData: boolean;
  };
  weight: { count: number; values: { date: LocalDate; value: number }[]; average: number | null; change: number | null; enough: boolean };
  steps: { daysWithData: number; average: number | null; min: number | null; max: number | null; unknownDays: number; goal: number | null };
  sleep: { daysWithData: number; averageMinutes: number | null };
  energy: { daysWithData: number; average: number | null };
  workouts: { target: number; planned: number; completed: number; skipped: number; needsReschedule: number; unknown: number; manualSessions: number; completedWeekdays: number[]; preferredDays: number[] | null };
  extraWork: { plannedMinutes: number; actualMinutes: number; sessions: number; warnAtMinutes: number; days: { date: LocalDate; plannedMinutes: number }[] };
  ownProject: { targetMinutes: number; plannedMinutes: number; completedMinutes: number };
  notifications: { sent: number; acknowledged: number; rate: number | null; byKind: { kind: string; label: string; sent: number; acknowledged: number }[] };
  reasons: { reschedule: { reason: string; count: number }[]; skip: { reason: string; count: number }[]; rescheduleCount: number; snoozeCount: number };
  shifts: { kind: EventKind; label: string; count: number; laterCount: number; medianLaterMinutes: number | null; workdayOnly: boolean }[];
  tasks: { created: number; completed: number; importantCompleted: number; waitingNow: number; overdue: number };
  eveningReviews: { done: number; skipped: number };
  habits: { noWorkInBed: { kept: number; broken: number } | null };
  interactionDays: number;
  summaryLines: string[];
}

interface EvRow {
  id: string;
  localDate: string;
  startAt: Date;
  endAt: Date;
  kind: EventKind;
  status: string;
  reason: string | null;
  actualStart: Date | null;
  actualMinutes: number | null;
  statusChangedAt: Date | null;
}

const minutesOf = (e: { startAt: Date; endAt: Date }) => Math.round((e.endAt.getTime() - e.startAt.getTime()) / 60000);
const round1 = (n: number) => Math.round(n * 10) / 10;
function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}
function countBy(xs: string[]): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1);
  return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason));
}
function plural(n: number, one: string, few: string, many: string): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
const hours = (m: number) => (m % 60 === 0 ? `${m / 60} ч` : `${round1(m / 60)} ч`);

export async function computeWeekFacts(tx: Tx, ctx: UserContext, now: DateTime, weekStart: LocalDate): Promise<WeekFacts> {
  const uid = ctx.userId;
  const ws = weekStart;
  const we = addDays(ws, 6);
  const { start, end } = weekBoundsUtc(ws, ctx.tz); // [Mon 00:00, next Mon 00:00) local → UTC
  const startJs = start.toJSDate();
  const endJs = end.toJSDate();
  const nowJs = now.toJSDate();
  const today = localDateOf(now, ctx.tz);
  const lastFactDay = today < we ? today : we;
  const elapsed = today < ws ? 0 : weekDates(ws).filter((d) => d <= lastFactDay).length;

  // events by local_date (REV-01: 2–8 Nov never includes 9 Nov)
  const evs = await tx<EvRow[]>`
    select id, local_date, start_at, end_at, kind, status, reason, actual_start, actual_minutes, status_changed_at
    from schedule_events where user_id = ${uid} and local_date between ${ws} and ${we}`;

  const blank = () => ({ planned: 0, completed: 0, skipped: 0, unknown: 0, started: 0, needsReschedule: 0, upcoming: 0, cancelled: 0 });
  const byKind = new Map<EventKind, KindStat>();
  const total = blank();
  for (const e of evs) {
    if (!TRACKED.includes(e.kind)) continue;
    const k = byKind.get(e.kind) ?? { kind: e.kind, label: KIND_LABELS[e.kind] ?? e.kind, ...blank() };
    byKind.set(e.kind, k);
    const bump = (f: keyof ReturnType<typeof blank>) => {
      k[f]++;
      total[f]++;
    };
    if (e.status === 'cancelled') {
      bump('cancelled');
      continue;
    }
    bump('planned');
    if (e.status === 'completed') bump('completed');
    else if (e.status === 'skipped') bump('skipped');
    else if (e.status === 'rescheduled') bump('needsReschedule');
    else if (e.status === 'started') bump('started');
    else if (OPEN.has(e.status)) bump(e.endAt > nowJs ? 'upcoming' : 'unknown');
  }

  // meals: an event answer or an explicit meal log, per day and slot
  const logs = await tx<{ localDate: string; mealSlot: string; consumptionStatus: string }[]>`
    select local_date, meal_slot, consumption_status from meal_logs where user_id = ${uid} and local_date between ${ws} and ${we}`;
  const factDays = weekDates(ws).filter((d) => d <= lastFactDay);
  const slots = MAIN_MEALS.map((m) => {
    let plannedDays = 0;
    let confirmedDays = 0;
    let skippedDays = 0;
    let unknownDays = 0;
    for (const d of factDays) {
      const dayEvs = evs.filter((e) => e.localDate === d && e.kind === m.kind && e.status !== 'cancelled');
      const dayLogs = logs.filter((l) => l.localDate === d && l.mealSlot === m.slot);
      const confirmed = dayEvs.some((e) => e.status === 'completed') || dayLogs.some((l) => l.consumptionStatus !== 'not_eaten');
      const skipped = !confirmed && (dayEvs.some((e) => e.status === 'skipped') || dayLogs.some((l) => l.consumptionStatus === 'not_eaten'));
      if (dayEvs.length) plannedDays++;
      if (confirmed) confirmedDays++;
      else if (skipped) skippedDays++;
      else if (dayEvs.some((e) => e.endAt <= nowJs)) unknownDays++;
    }
    return { slot: m.slot, label: m.label, plannedDays, confirmedDays, skippedDays, unknownDays };
  });
  let daysWithAllMain = 0;
  for (const d of factDays) {
    const ok = MAIN_MEALS.every(
      (m) =>
        evs.some((e) => e.localDate === d && e.kind === m.kind && e.status === 'completed') ||
        logs.some((l) => l.localDate === d && l.mealSlot === m.slot && l.consumptionStatus !== 'not_eaten'),
    );
    if (ok) daysWithAllMain++;
  }
  const snackDays = new Set([
    ...evs.filter((e) => e.kind === 'snack' && e.status === 'completed').map((e) => e.localDate),
    ...logs.filter((l) => l.mealSlot === 'snack' && l.consumptionStatus !== 'not_eaten').map((l) => l.localDate),
  ]);
  const snacksConfirmed =
    evs.filter((e) => e.kind === 'snack' && e.status === 'completed').length +
    logs.filter((l) => l.mealSlot === 'snack' && l.consumptionStatus !== 'not_eaten').length;

  // health measurements
  const hm = await tx<{ metricType: string; localDate: string; value: number }[]>`
    select metric_type, local_date, sum(value)::float as value from health_measurements
    where user_id = ${uid} and local_date between ${ws} and ${we} and metric_type in ('weight','steps','sleep_minutes','energy')
    group by metric_type, local_date order by local_date`;
  const series = (m: string) => hm.filter((r) => r.metricType === m).map((r) => ({ date: r.localDate, value: r.value }));
  const weightVals = series('weight');
  const enoughWeight = weightVals.length >= 3;
  const stepVals = series('steps');
  const avg = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null);
  const sleepVals = series('sleep_minutes');
  const energyVals = series('energy');

  // workouts
  const sessions = await tx<{ localDate: string; scheduleEventId: string | null }[]>`
    select local_date, schedule_event_id from workout_sessions
    where user_id = ${uid} and status = 'completed' and local_date between ${ws} and ${we}`;
  const wk = byKind.get('workout');
  const completedWorkoutEvents = evs.filter((e) => e.kind === 'workout' && e.status === 'completed');
  const manual = sessions.filter((s) => !s.scheduleEventId || !completedWorkoutEvents.some((e) => e.id === s.scheduleEventId));
  const workoutDays = [...completedWorkoutEvents.map((e) => e.localDate), ...manual.map((s) => s.localDate)];

  // extra work and own projects
  const extra = evs.filter((e) => e.kind === 'extra_work' && !['cancelled', 'skipped'].includes(e.status));
  const extraDays = new Map<string, number>();
  for (const e of extra) extraDays.set(e.localDate, (extraDays.get(e.localDate) ?? 0) + minutesOf(e));
  const projects = evs.filter((e) => e.kind === 'own_project' && !['cancelled', 'skipped', 'rescheduled'].includes(e.status));

  // notifications: one "reminder" = all channel rows of one event; sent if any channel sent
  const outbox = await tx<{ eventId: string | null; id: string; kind: string | null; sent: boolean; acked: boolean }[]>`
    select o.event_id, o.id, e.kind, (o.sent_at is not null) as sent, (o.acknowledged_at is not null) as acked
    from notification_outbox o left join schedule_events e on e.id = o.event_id
    where o.user_id = ${uid} and o.scheduled_at >= ${startJs} and o.scheduled_at < ${endJs}`;
  const groups = new Map<string, { kind: string; sent: boolean; acked: boolean }>();
  for (const o of outbox) {
    const key = o.eventId ?? o.id;
    const g = groups.get(key) ?? { kind: o.kind ?? 'other', sent: false, acked: false };
    g.sent ||= o.sent;
    g.acked ||= o.acked;
    groups.set(key, g);
  }
  const notifByKind = new Map<string, { kind: string; label: string; sent: number; acknowledged: number }>();
  let sent = 0;
  let acknowledged = 0;
  for (const g of groups.values()) {
    if (!g.sent) continue;
    sent++;
    if (g.acked) acknowledged++;
    const k = notifByKind.get(g.kind) ?? { kind: g.kind, label: KIND_LABELS[g.kind as EventKind] ?? 'Другое', sent: 0, acknowledged: 0 };
    k.sent++;
    if (g.acked) k.acknowledged++;
    notifByKind.set(g.kind, k);
  }

  // reschedule reasons and time shifts: changes of events that were planned for this local week
  const changes = await tx<{ eventId: string | null; action: string; reason: string | null; kind: EventKind | null; eventLocalDate: string | null; fromJson: { startAt?: string } | null; toJson: { startAt?: string } | null }[]>`
    select c.event_id, c.action, c.reason, e.kind, e.local_date as event_local_date, c.from_json, c.to_json
    from plan_changes c left join schedule_events e on e.id = c.event_id
    where c.user_id = ${uid} and c.action in ('reschedule', 'snooze', 'move')
      and (
        (c.from_json->>'localDate') between ${ws} and ${we}
        or (c.from_json->>'localDate' is null and c.created_at >= ${startJs} and c.created_at < ${endJs})
      )
    order by c.created_at`;
  // one entry per event: a lunch snoozed twice is one lunch that moved, by the total shift
  const perEvent = new Map<string, { kind: EventKind; localDate: string | null; firstFrom: string; lastTo: string }>();
  for (const c of changes) {
    if (!c.kind || !c.eventId || !c.fromJson?.startAt || !c.toJson?.startAt) continue;
    const cur = perEvent.get(c.eventId);
    if (cur) cur.lastTo = c.toJson.startAt;
    else perEvent.set(c.eventId, { kind: c.kind, localDate: c.eventLocalDate, firstFrom: c.fromJson.startAt, lastTo: c.toJson.startAt });
  }
  const shiftMap = new Map<EventKind, { count: number; later: number[] }>();
  for (const c of perEvent.values()) {
    const from = localTimeOf(c.firstFrom, ctx.tz);
    const to = localTimeOf(c.lastTo, ctx.tz);
    const sameDay = localDateOf(c.firstFrom, ctx.tz) === localDateOf(c.lastTo, ctx.tz);
    const s = shiftMap.get(c.kind) ?? { count: 0, later: [] };
    s.count++;
    const delta = timeToMinutes(to) - timeToMinutes(from);
    if (sameDay && delta > 0 && (c.kind !== 'meal_lunch' || ctx.prefs.workDays.includes(isoWeekday(c.localDate ?? ws)))) s.later.push(delta);
    shiftMap.set(c.kind, s);
  }
  // a started meal more than 20 min after its planned time also counts as "later" (unless already counted as moved)
  for (const e of evs) {
    if (e.kind !== 'meal_lunch' || !e.actualStart || !ctx.prefs.workDays.includes(isoWeekday(e.localDate)) || perEvent.has(e.id)) continue;
    const delta = Math.round((e.actualStart.getTime() - e.startAt.getTime()) / 60000);
    if (delta >= 20) {
      const s = shiftMap.get('meal_lunch') ?? { count: 0, later: [] };
      s.count++;
      s.later.push(delta);
      shiftMap.set('meal_lunch', s);
    }
  }

  // tasks (overdue = still open and the due date passed: before today, or within a finished week)
  const overdueCutoff = today <= we ? today : addDays(we, 1);
  const [t] = await tx<{ created: number; completed: number; important: number; waiting: number; overdue: number }[]>`
    select
      count(*) filter (where created_at >= ${startJs} and created_at < ${endJs})::int as created,
      count(*) filter (where status = 'done' and completed_at >= ${startJs} and completed_at < ${endJs})::int as completed,
      count(*) filter (where status = 'done' and priority = 'high' and completed_at >= ${startJs} and completed_at < ${endJs})::int as important,
      count(*) filter (where status = 'waiting')::int as waiting,
      count(*) filter (where status in ('inbox','todo','in_progress','scheduled') and due_date is not null and due_date < ${overdueCutoff})::int as overdue
    from tasks where user_id = ${uid}`;

  // evening reviews, habits
  const plans = await tx<{ localDate: string; eveningReviewedAt: Date | null; eveningReviewSkipped: boolean }[]>`
    select local_date, evening_reviewed_at, evening_review_skipped from day_plans
    where user_id = ${uid} and local_date between ${ws} and ${we}`;
  const bed = await tx<{ status: string }[]>`
    select c.status from habit_checkins c join habit_definitions h on h.id = c.habit_id
    where c.user_id = ${uid} and h.key = 'no_work_in_bed' and c.local_date between ${ws} and ${we}`;

  // days with at least one conscious interaction (PRD §20.2)
  const touched = new Set<string>();
  for (const e of evs) if (['completed', 'skipped', 'started'].includes(e.status) && e.statusChangedAt) touched.add(localDateOf(e.statusChangedAt, ctx.tz));
  for (const l of logs) touched.add(l.localDate);
  for (const r of hm) touched.add(r.localDate);
  for (const p of plans) if (p.eveningReviewedAt || p.eveningReviewSkipped) touched.add(p.localDate);
  const inboxDays = await tx<{ createdAt: Date }[]>`
    select created_at from inbox_items where user_id = ${uid} and created_at >= ${startJs} and created_at < ${endJs}`;
  for (const i of inboxDays) touched.add(localDateOf(i.createdAt, ctx.tz));
  const interactionDays = [...touched].filter((d) => d >= ws && d <= we).length;

  const skipReasons = evs.filter((e) => e.status === 'skipped' && e.reason).map((e) => e.reason!.trim());
  const rescheduleReasons = changes.filter((c) => c.action !== 'snooze' && c.reason).map((c) => c.reason!.trim());

  const facts: WeekFacts = {
    weekStart: ws,
    weekEnd: we,
    tz: ctx.tz,
    generatedAt: now.toISO()!,
    isComplete: now >= end,
    daysElapsed: elapsed,
    events: { total, byKind: TRACKED.map((k) => byKind.get(k)).filter((k): k is KindStat => !!k) },
    meals: {
      slots,
      confirmedBreakfastDays: slots[0]!.confirmedDays,
      daysWithAllMain,
      snacksConfirmed,
      anyData: slots.some((s) => s.confirmedDays + s.skippedDays > 0) || snackDays.size > 0,
    },
    weight: {
      count: weightVals.length,
      values: weightVals,
      average: enoughWeight ? round1(avg(weightVals.map((v) => v.value))!) : null,
      change: enoughWeight ? round1(weightVals[weightVals.length - 1]!.value - weightVals[0]!.value) : null,
      enough: enoughWeight,
    },
    steps: {
      daysWithData: stepVals.length,
      average: stepVals.length ? Math.round(avg(stepVals.map((v) => v.value))!) : null,
      min: stepVals.length ? Math.min(...stepVals.map((v) => v.value)) : null,
      max: stepVals.length ? Math.max(...stepVals.map((v) => v.value)) : null,
      unknownDays: Math.max(0, elapsed - stepVals.length),
      goal: ctx.prefs.targets.stepsGoal,
    },
    sleep: { daysWithData: sleepVals.length, averageMinutes: sleepVals.length ? Math.round(avg(sleepVals.map((v) => v.value))!) : null },
    energy: { daysWithData: energyVals.length, average: energyVals.length ? round1(avg(energyVals.map((v) => v.value))!) : null },
    workouts: {
      target: ctx.prefs.targets.workouts,
      planned: wk?.planned ?? 0,
      completed: completedWorkoutEvents.length + manual.length,
      skipped: wk?.skipped ?? 0,
      needsReschedule: wk?.needsReschedule ?? 0,
      unknown: wk?.unknown ?? 0,
      manualSessions: manual.length,
      completedWeekdays: [...new Set(workoutDays.map(isoWeekday))].sort(),
      preferredDays: ctx.prefs.gymDays,
    },
    extraWork: {
      plannedMinutes: extra.reduce((s, e) => s + minutesOf(e), 0),
      actualMinutes: extra.filter((e) => e.status === 'completed').reduce((s, e) => s + (e.actualMinutes ?? minutesOf(e)), 0),
      sessions: extra.length,
      warnAtMinutes: ctx.prefs.overtimeWarnMinutes,
      days: [...extraDays.entries()].map(([date, plannedMinutes]) => ({ date, plannedMinutes })).sort((a, b) => a.date.localeCompare(b.date)),
    },
    ownProject: {
      targetMinutes: ctx.prefs.targets.projectMinutes,
      plannedMinutes: projects.reduce((s, e) => s + minutesOf(e), 0),
      completedMinutes: projects.filter((e) => e.status === 'completed').reduce((s, e) => s + (e.actualMinutes ?? minutesOf(e)), 0),
    },
    notifications: { sent, acknowledged, rate: sent ? acknowledged / sent : null, byKind: [...notifByKind.values()].sort((a, b) => b.sent - a.sent) },
    reasons: {
      reschedule: countBy(rescheduleReasons),
      skip: countBy(skipReasons),
      rescheduleCount: changes.filter((c) => c.action !== 'snooze').length,
      snoozeCount: changes.filter((c) => c.action === 'snooze').length,
    },
    shifts: [...shiftMap.entries()].map(([kind, s]) => ({
      kind,
      label: KIND_LABELS[kind] ?? kind,
      count: s.count,
      laterCount: s.later.length,
      medianLaterMinutes: median(s.later),
      workdayOnly: kind === 'meal_lunch',
    })),
    tasks: { created: t?.created ?? 0, completed: t?.completed ?? 0, importantCompleted: t?.important ?? 0, waitingNow: t?.waiting ?? 0, overdue: t?.overdue ?? 0 },
    eveningReviews: { done: plans.filter((p) => p.eveningReviewedAt).length, skipped: plans.filter((p) => p.eveningReviewSkipped && !p.eveningReviewedAt).length },
    habits: {
      noWorkInBed: bed.length ? { kept: bed.filter((b) => b.status === 'done').length, broken: bed.filter((b) => b.status === 'skipped' || b.status === 'partial').length } : null,
    },
    interactionDays,
    summaryLines: [],
  };
  facts.summaryLines = summaryLines(facts);
  return facts;
}

/** Deterministic text: always available, also the fallback when AI is off or fails. */
export function summaryLines(f: WeekFacts): string[] {
  const out: string[] = [];
  const t = f.events.total;
  const past = t.planned - t.upcoming;
  if (!t.planned) out.push('События: в плане недели нет событий — нет данных для сравнения.');
  else
    out.push(
      `События: выполнено ${t.completed} из ${past} прошедших` +
        (t.skipped ? `, пропущено ${t.skipped}` : '') +
        (t.unknown ? `, без ответа ${t.unknown} (это «неизвестно», не «пропущено»)` : '') +
        (t.upcoming ? `; ещё впереди ${t.upcoming}` : '') +
        '.',
    );
  const b = f.meals.slots[0]!;
  if (!f.meals.anyData) out.push('Еда: отметок нет — нет данных.');
  else out.push(`Еда: завтрак подтверждён в ${b.confirmedDays} из ${b.plannedDays} дн., все три основных приёма — в ${f.meals.daysWithAllMain} дн.`);
  if (!f.weight.count) out.push('Вес: измерений нет — нет данных.');
  else if (!f.weight.enough) out.push(`Вес: ${f.weight.count} ${plural(f.weight.count, 'измерение', 'измерения', 'измерений')} — мало данных для среднего и тренда (нужно от 3).`);
  else out.push(`Вес: в среднем ${f.weight.average} кг по ${f.weight.count} измерениям; от первого к последнему ${f.weight.change! > 0 ? '+' : ''}${f.weight.change} кг.`);
  if (!f.steps.daysWithData) out.push('Шаги: нет данных.');
  else out.push(`Шаги: данные за ${f.steps.daysWithData} из ${f.daysElapsed} дн., в среднем ${f.steps.average!.toLocaleString('ru-RU')}${f.steps.unknownDays ? `; без данных ${f.steps.unknownDays} дн.` : ''}.`);
  if (!f.workouts.planned && !f.workouts.completed) out.push('Тренировки: в плане не было и отметок нет — нет данных.');
  else
    out.push(
      f.workouts.target
        ? `Тренировки: ${f.workouts.completed} из цели ${f.workouts.target}${f.workouts.skipped ? `, пропущено ${f.workouts.skipped}` : ''}${f.workouts.unknown ? `, без ответа ${f.workouts.unknown}` : ''}.`
        : `Тренировки: цель не задана, выполнено ${f.workouts.completed}.`,
    );
  if (f.extraWork.sessions)
    out.push(`Дополнительная работа: запланировано ${hours(f.extraWork.plannedMinutes)}, подтверждено ${hours(f.extraWork.actualMinutes)} (порог недели ${hours(f.extraWork.warnAtMinutes)}).`);
  else out.push('Дополнительная работа: не планировалась.');
  if (f.ownProject.plannedMinutes || f.ownProject.completedMinutes)
    out.push(`Свои проекты: подтверждено ${hours(f.ownProject.completedMinutes)} из запланированных ${hours(f.ownProject.plannedMinutes)} (цель ${hours(f.ownProject.targetMinutes)}).`);
  out.push(
    f.notifications.sent
      ? `Напоминания: ответ после ${f.notifications.acknowledged} из ${f.notifications.sent} отправленных.`
      : 'Напоминания: за неделю не отправлялись — нет данных о подтверждениях.',
  );
  out.push(`Дела: создано ${f.tasks.created}, закрыто ${f.tasks.completed}, ждут ответа ${f.tasks.waitingNow}, просрочено ${f.tasks.overdue}.`);
  if (f.sleep.daysWithData) out.push(`Сон: записи за ${f.sleep.daysWithData} дн., в среднем ${hours(f.sleep.averageMinutes!)}.`);
  if (f.energy.daysWithData) out.push(`Энергия: в среднем ${f.energy.average} из 5 по ${f.energy.daysWithData} дн.`);
  out.push(`Дней с отметками в приложении: ${f.interactionDays} из ${f.daysElapsed}.`);
  return out;
}

// ---------------------------------------------------------------------------
// patterns (2–3, each with the fact it is based on)
// ---------------------------------------------------------------------------
export interface Pattern {
  key: string;
  text: string;
  basedOn: string;
}

function ignoredReminder(f: WeekFacts) {
  return f.notifications.byKind
    .filter((k) => k.sent >= 3 && k.acknowledged / k.sent <= 0.34 && k.kind !== 'other')
    .sort((a, b) => a.acknowledged / a.sent - b.acknowledged / b.sent || b.sent - a.sent)[0];
}
function lunchShift(f: WeekFacts) {
  const s = f.shifts.find((x) => x.kind === 'meal_lunch');
  return s && s.laterCount >= 2 && (s.medianLaterMinutes ?? 0) >= 15 ? s : null;
}
function longDays(f: WeekFacts) {
  return f.extraWork.days.filter((d) => d.plannedMinutes >= 60);
}

export function detectPatterns(f: WeekFacts): Pattern[] {
  const out: Pattern[] = [];
  const t = f.events.total;
  const past = t.planned - t.upcoming;
  if (past >= 4 && t.unknown / past >= 0.5) {
    out.push({
      key: 'low_data',
      text: `Больше половины прошедших событий остались без ответа (${t.unknown} из ${past}) — выводы ниже осторожные.`,
      basedOn: 'Статусы событий недели',
    });
  }
  const ls = lunchShift(f);
  if (ls) {
    out.push({
      key: 'lunch_late',
      text: `Обед в рабочие дни чаще сдвигался позже плана: ${ls.laterCount} ${plural(ls.laterCount, 'раз', 'раза', 'раз')}, обычно на ~${ls.medianLaterMinutes} мин.`,
      basedOn: 'Переносы и фактическое начало обеда',
    });
  }
  const ig = ignoredReminder(f);
  if (ig) {
    out.push({
      key: 'ignored_reminders',
      text: `Напоминания «${ig.label}» обычно оставались без ответа: ответ после ${ig.acknowledged} из ${ig.sent}.`,
      basedOn: 'Отправленные напоминания и ответы на них',
    });
  }
  const w = f.workouts;
  const wUpcoming = f.events.byKind.find((k) => k.kind === 'workout')?.upcoming ?? 0;
  const wAnswered = w.completed + w.skipped + w.needsReschedule;
  // only when the week's workouts are behind us and at least one was answered: unknown ≠ not done
  if (w.target && w.planned > 0 && w.completed < w.target && wUpcoming === 0 && wAnswered > 0) {
    const reasons = f.reasons.reschedule.concat(f.reasons.skip).slice(0, 2).map((r) => `«${r.reason}» ×${r.count}`).join(', ');
    out.push({
      key: 'workouts_below_target',
      text: `Тренировок ${w.completed} из ${w.target}${w.unknown ? `, без ответа ${w.unknown}` : ''}${reasons ? `; причины переносов и пропусков: ${reasons}` : ''}. Цель не снижаем — ищем удобное время.`,
      basedOn: 'Статусы тренировок и причины',
    });
  }
  const ld = longDays(f);
  if (ld.length >= 2) {
    out.push({
      key: 'long_days',
      text: `В ${ld.length} ${plural(ld.length, 'день', 'дня', 'дней')} была дополнительная работа от часа — в такие дни важно не пропускать еду.`,
      basedOn: `Дополнительная работа: ${ld.map((d) => formatDateRu(d.date)).join(', ')}`,
    });
  }
  if (f.extraWork.plannedMinutes > f.extraWork.warnAtMinutes && f.extraWork.warnAtMinutes > 0) {
    out.push({
      key: 'overtime',
      text: `Дополнительной работы запланировано ${hours(f.extraWork.plannedMinutes)} при пороге ${hours(f.extraWork.warnAtMinutes)}.`,
      basedOn: 'События дополнительной работы',
    });
  }
  if (f.meals.confirmedBreakfastDays >= 5) {
    out.push({ key: 'breakfast_regular', text: `Завтрак подтверждён в ${f.meals.confirmedBreakfastDays} дн. — регулярность есть.`, basedOn: 'Отметки завтрака' });
  }
  if (f.steps.daysWithData >= 5) {
    out.push({ key: 'steps_baseline', text: `Шаги: устойчивый средний уровень ~${f.steps.average!.toLocaleString('ru-RU')} по ${f.steps.daysWithData} дн.`, basedOn: 'Записи шагов' });
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// proposals (2–3), never applied automatically
// ---------------------------------------------------------------------------
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
export const applySchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meal_time'), meal: z.literal('lunch'), from: hhmm, to: hhmm }),
  z.object({ type: z.literal('snack_reminders'), from: z.boolean(), to: z.boolean() }),
  z.object({ type: z.literal('repeat_minutes'), from: z.number().int(), to: z.number().int().min(5).max(60) }),
  z.object({ type: z.literal('workout_lead'), from: z.number().int(), to: z.number().int().min(0).max(120) }),
  z.object({ type: z.literal('evening_review_time'), from: hhmm.nullable(), fromEffective: hhmm, to: hhmm }),
  z.object({ type: z.literal('steps_goal'), from: z.number().int().nullable(), to: z.number().int().min(500).max(50000) }),
  z.object({ type: z.literal('add_snack_time'), time: hhmm, fromTimes: z.array(hhmm), toTimes: z.array(hhmm).max(4), wasEnabled: z.boolean() }),
  z.object({ type: z.literal('gym_days'), from: z.array(z.number().int().min(1).max(7)).nullable(), to: z.array(z.number().int().min(1).max(7)).min(1) }),
]);
export type ApplyPayload = z.infer<typeof applySchema>;

export interface Proposal {
  id: string;
  title: string;
  why: string;
  consequences: string;
  diff: { label: string; from: string; to: string }[];
  affects: { events: number; dates: LocalDate[]; note: string };
  apply: ApplyPayload;
}

const dayList = (days: number[]) => days.map(weekdayShort).join(', ');

async function futureTemplateEvents(tx: Tx, ctx: UserContext, now: DateTime, keyPrefixes: string[]) {
  const rows = await tx<{ localDate: string }[]>`
    select e.local_date from schedule_events e join schedule_templates t on t.id = e.template_id
    where e.user_id = ${ctx.userId} and e.start_at > ${now.toJSDate()} and e.status = 'planned' and e.revision = 1
      and (e.origin_key like 'tpl:%' or e.origin_key like 'quota:%')
      and exists (select 1 from unnest(${keyPrefixes}::text[]) p where t.key like p || '%')
    order by e.start_at`;
  return { events: rows.length, dates: [...new Set(rows.map((r) => r.localDate))] };
}

const UNTOUCHED_NOTE = 'Меняются только будущие события, которые ты не трогал; отмеченные и перенесённые вручную остаются как есть.';

export async function buildProposals(tx: Tx, ctx: UserContext, now: DateTime, f: WeekFacts): Promise<Proposal[]> {
  const p = ctx.prefs;
  const out: Proposal[] = [];

  // 1. lunch later (only inside its own window, never shortening it)
  const ls = lunchShift(f);
  if (ls && p.workDays.length) {
    const w = p.meals.lunch;
    const delta = Math.min(60, Math.max(15, Math.round((ls.medianLaterMinutes ?? 15) / 15) * 15));
    const latestStart = timeToMinutes(w.latest) - w.duration;
    const toMin = Math.min(timeToMinutes(w.start) + delta, latestStart);
    if (toMin > timeToMinutes(w.start)) {
      const to = minutesToTime(toMin);
      const aff = await futureTemplateEvents(tx, ctx, now, ['lunch_workday']);
      out.push({
        id: 'lunch_shift',
        title: `Перенести обед в рабочие дни на ${to}`,
        why: `Обед ${ls.laterCount} ${plural(ls.laterCount, 'раз', 'раза', 'раз')} сдвигался позже, обычно на ~${ls.medianLaterMinutes} мин.`,
        consequences: `Обед останется ${w.duration} мин в окне ${w.earliest}–${w.latest}. ${UNTOUCHED_NOTE}`,
        diff: [{ label: 'Обед (рабочие дни)', from: `${w.start}–${minutesToTime(timeToMinutes(w.start) + w.duration)}`, to: `${to}–${minutesToTime(toMin + w.duration)}` }],
        affects: { ...aff, note: aff.events ? `Будет перестроено событий: ${aff.events}` : 'Изменится шаблон; новые дни построятся по нему' },
        apply: { type: 'meal_time', meal: 'lunch', from: w.start, to },
      });
    }
  }

  // 2. a systematically ignored reminder type → adjust how/when it reminds (not the habit itself)
  const ig = ignoredReminder(f);
  if (ig) {
    const n = p.notifications;
    const why = `На напоминания «${ig.label}» ответ был после ${ig.acknowledged} из ${ig.sent}.`;
    if (ig.kind === 'snack' && n.snackReminders) {
      const aff = await futureTemplateEvents(tx, ctx, now, ['snack_']);
      out.push({
        id: 'reminder_snack',
        title: 'Не напоминать о перекусах',
        why,
        consequences: 'Перекусы остаются в плане и их можно отмечать; пропадут только мягкие напоминания о них.',
        diff: [{ label: 'Напоминания о перекусах', from: 'включены', to: 'выключены' }],
        affects: { ...aff, events: 0, note: aff.events ? `Будут отменены напоминания для ${aff.events} будущих перекусов` : 'Новые напоминания о перекусах не создаются' },
        apply: { type: 'snack_reminders', from: true, to: false },
      });
    } else if (ig.kind === 'workout') {
      const to = Math.min(120, n.workoutLeadMinutes + 30);
      if (to > n.workoutLeadMinutes) {
        out.push({
          id: 'reminder_workout',
          title: `Напоминать о тренировке за ${to} мин`,
          why,
          consequences: 'Сами тренировки, их время и цель на неделю не меняются — только время напоминания, чтобы успеть собраться.',
          diff: [{ label: 'Напоминание о тренировке', from: `за ${n.workoutLeadMinutes} мин`, to: `за ${to} мин` }],
          affects: { events: 0, dates: [], note: 'Пересчитаются будущие напоминания о тренировках' },
          apply: { type: 'workout_lead', from: n.workoutLeadMinutes, to },
        });
      }
    } else if (ig.kind === 'review') {
      const cur = eveningReviewTime(p);
      const to = minutesToTime(timeToMinutes(cur) - 30);
      out.push({
        id: 'reminder_review',
        title: `Вечерний обзор в ${to}`,
        why,
        consequences: 'Обзор раньше — чтобы не планировать перед самым сном. Сон не сокращается.',
        diff: [{ label: 'Вечерний обзор', from: cur, to }],
        affects: { ...(await futureTemplateEvents(tx, ctx, now, ['evening_review'])), note: UNTOUCHED_NOTE },
        apply: { type: 'evening_review_time', from: n.eveningReviewTime, fromEffective: cur, to },
      });
    } else if (['meal_breakfast', 'meal_lunch', 'meal_dinner', 'task', 'work', 'extra_work', 'custom'].includes(ig.kind) && n.maxRepeats > 0) {
      const to = Math.min(60, n.repeatMinutes + 10);
      if (to > n.repeatMinutes) {
        out.push({
          id: 'reminder_repeat',
          title: `Повтор напоминания через ${to} мин`,
          why,
          consequences: 'Повтор будет позже — меньше дёрганий во время созвонов. События не меняются, повтор по-прежнему один.',
          diff: [{ label: 'Повтор важного напоминания', from: `через ${n.repeatMinutes} мин`, to: `через ${to} мин` }],
          affects: { events: 0, dates: [], note: 'Касается только будущих повторов' },
          apply: { type: 'repeat_minutes', from: n.repeatMinutes, to },
        });
      }
    }
  }

  // 3. gradual step goal: +500 and only with ≥5 days of data, never as a penalty
  if (f.steps.daysWithData >= 5 && f.steps.average !== null) {
    const cur = p.targets.stepsGoal;
    let to: number | null = null;
    if (cur === null) to = Math.max(1000, Math.floor(f.steps.average / 500) * 500 + 500);
    else if (f.steps.average >= cur * 0.9) to = Math.min(50000, cur + 500);
    if (to !== null && to !== cur) {
      out.push({
        id: 'steps_goal',
        title: `Цель шагов: ${to.toLocaleString('ru-RU')}`,
        why: `Средние шаги ~${f.steps.average.toLocaleString('ru-RU')} по ${f.steps.daysWithData} дн. с данными.`,
        consequences: 'Постепенно, +500 шагов. Низкая активность не штрафуется; дни без данных — «нет данных».',
        diff: [{ label: 'Цель шагов в день', from: cur === null ? 'не задана' : cur.toLocaleString('ru-RU'), to: to.toLocaleString('ru-RU') }],
        affects: { events: 0, dates: [], note: 'Меняется только цель, события плана не затрагиваются' },
        apply: { type: 'steps_goal', from: cur, to },
      });
    }
  }

  // 4. snack before long evenings
  const ld = longDays(f);
  if (ld.length >= 2 && p.workDays.length) {
    const time = minutesToTime(timeToMinutes(p.workEnd) - 30);
    const s = p.meals.snacks;
    const fromTimes = s.enabled ? s.times : [];
    const near = fromTimes.some((x) => Math.abs(timeToMinutes(x) - timeToMinutes(time)) < 45);
    if (!near && fromTimes.length < 4) {
      out.push({
        id: 'snack_long_days',
        title: `Перекус в ${time} в рабочие дни`,
        why: `Дополнительная работа от часа была в ${ld.length} ${plural(ld.length, 'день', 'дня', 'дней')}.`,
        consequences: `Короткий перекус ${s.duration} мин перед вечером; можно отмечать или пропускать. ${UNTOUCHED_NOTE}`,
        diff: [{ label: 'Перекусы в рабочие дни', from: fromTimes.length ? fromTimes.join(', ') : 'нет', to: [...fromTimes, time].join(', ') }],
        affects: { events: 0, dates: [], note: 'Добавятся будущие перекусы в рабочие дни' },
        apply: { type: 'add_snack_time', time, fromTimes, toTimes: [...fromTimes, time], wasEnabled: s.enabled },
      });
    }
  }

  // 5. preferred gym days from where workouts actually happened (never fewer workouts)
  const done = f.workouts.completedWeekdays;
  const pref = p.gymDays;
  if (f.workouts.target > 0 && done.length >= Math.min(2, f.workouts.target)) {
    const differs = !pref || done.some((d) => !pref.includes(d));
    const missedPreferred = !pref || f.workouts.skipped + f.workouts.needsReschedule > 0 || f.reasons.rescheduleCount > 0;
    if (differs && missedPreferred && JSON.stringify(done) !== JSON.stringify(pref)) {
      const aff = await futureTemplateEvents(tx, ctx, now, ['gym']);
      out.push({
        id: 'gym_days',
        title: `Предпочтительные дни тренировок: ${dayList(done)}`,
        why: `На этой неделе тренировки состоялись в ${dayList(done)}.`,
        consequences: `Цель остаётся ${f.workouts.target} в неделю; планировщик будет сначала пробовать эти дни. ${UNTOUCHED_NOTE}`,
        diff: [{ label: 'Дни тренировок', from: pref ? dayList(pref) : 'любые', to: dayList(done) }],
        affects: { ...aff, note: aff.events ? `Будет перестроено тренировок: ${aff.events}` : 'Новые недели построятся по этим дням' },
        apply: { type: 'gym_days', from: pref, to: done },
      });
    }
  }
  return out.slice(0, 3);
}

// ---------------------------------------------------------------------------
// applying an accepted proposal (inside the decide transaction)
// ---------------------------------------------------------------------------
type Effect = 'events' | 'reminders' | 'none';

function stale(): AppError {
  return new AppError('PROPOSAL_STALE', 'Эта настройка уже изменилась после обзора. Обнови обзор и посмотри предложение ещё раз.', 409);
}

async function applyOne(tx: Tx, userId: string, a: ApplyPayload): Promise<{ effect: Effect; enableSnacks?: boolean }> {
  const [row] = await tx<{ mealWindows: unknown; notificationPreferences: unknown; weeklyTargets: unknown; gymDays: number[] | null }[]>`
    select meal_windows, notification_preferences, weekly_targets, gym_days from routine_preferences where user_id = ${userId} for update`;
  if (!row) throw new AppError('NO_PREFERENCES', 'Сначала пройди первую настройку', 409);
  const notif = (patch: Partial<NotificationPrefs>) => tx`
    update routine_preferences set notification_preferences = ${tx.json({ ...parseNotificationPrefs(row.notificationPreferences), ...patch } as never)}
    where user_id = ${userId}`;
  const n = parseNotificationPrefs(row.notificationPreferences);
  switch (a.type) {
    case 'meal_time': {
      const m = parseMealWindows(row.mealWindows);
      if (m.lunch.start !== a.from) throw stale();
      if (timeToMinutes(a.to) + m.lunch.duration > timeToMinutes(m.lunch.latest)) throw new AppError('OUT_OF_WINDOW', 'Новое время выходит за окно обеда', 422);
      m.lunch.start = a.to;
      await tx`update routine_preferences set meal_windows = ${tx.json(m as never)} where user_id = ${userId}`;
      return { effect: 'events' };
    }
    case 'snack_reminders':
      if (n.snackReminders !== a.from) throw stale();
      await notif({ snackReminders: a.to });
      return { effect: 'reminders' };
    case 'repeat_minutes':
      if (n.repeatMinutes !== a.from) throw stale();
      await notif({ repeatMinutes: a.to });
      return { effect: 'none' };
    case 'workout_lead':
      if (n.workoutLeadMinutes !== a.from) throw stale();
      await notif({ workoutLeadMinutes: a.to });
      return { effect: 'reminders' };
    case 'evening_review_time':
      if (n.eveningReviewTime !== a.from) throw stale();
      await notif({ eveningReviewTime: a.to });
      return { effect: 'events' };
    case 'steps_goal': {
      const t = parseWeeklyTargets(row.weeklyTargets);
      if (t.stepsGoal !== a.from) throw stale();
      t.stepsGoal = a.to;
      await tx`update routine_preferences set weekly_targets = ${tx.json(t as never)} where user_id = ${userId}`;
      await tx`update habit_definitions set target = ${a.to} where user_id = ${userId} and key = 'steps'`;
      return { effect: 'none' };
    }
    case 'add_snack_time': {
      const m = parseMealWindows(row.mealWindows);
      const cur = m.snacks.enabled ? m.snacks.times : [];
      if (JSON.stringify(cur) !== JSON.stringify(a.fromTimes) || m.snacks.enabled !== a.wasEnabled) throw stale();
      m.snacks = { ...m.snacks, enabled: true, times: a.toTimes };
      await tx`update routine_preferences set meal_windows = ${tx.json(m as never)} where user_id = ${userId}`;
      return { effect: 'events', enableSnacks: true };
    }
    case 'gym_days':
      if (JSON.stringify(row.gymDays ?? null) !== JSON.stringify(a.from)) throw stale();
      await tx`update routine_preferences set gym_days = ${a.to} where user_id = ${userId}`;
      return { effect: 'events' };
  }
}

/** Template keys that are currently switched on — mirrors profile.contextToForm. */
function enabledKeysOf(ctx: UserContext): Set<string> {
  const on = (prefix: string) => ctx.templates.some((t) => t.key.startsWith(prefix) && t.enabled);
  const keys = new Set<string>();
  if (on('breakfast')) keys.add('breakfast');
  if (on('lunch')) keys.add('lunch');
  if (on('dinner')) keys.add('dinner');
  if (on('snack')) keys.add('snacks');
  if (on('gym')) keys.add('workouts');
  if (on('own_project')) keys.add('own_project');
  return keys;
}

// ---------------------------------------------------------------------------
// persistence + views
// ---------------------------------------------------------------------------
interface ReviewRow {
  id: string;
  weekStartDate: string;
  factsJson: { facts: WeekFacts; patterns: Pattern[] };
  aiInsightsJson: AiBlock | null;
  proposalsJson: Proposal[];
  decisionsJson: Record<string, Decision>;
  status: 'generated' | 'decided';
  generatedAt: Date;
  confirmedAt: Date | null;
  userNote: string | null;
  generation: number;
}

export interface Decision {
  decision: 'accepted' | 'rejected' | 'kept';
  decidedAt: string;
  applied: boolean;
  summary: string | null;
}

export interface AiBlock {
  source: 'ai' | 'rules';
  label: string;
  summary: string | null;
  observations: { text: string; basedOn: string }[];
  suggestions: { text: string; why: string }[];
  error: string | null;
  generatedAt: string;
}

export function aiEligibility(ctx: UserContext): { eligible: boolean; reason: string } {
  if (!env().ENABLE_AI_WEEKLY_REVIEW) return { eligible: false, reason: 'ИИ-комментарий к обзору выключен на сервере.' };
  if (!aiProvider().canParse()) return { eligible: false, reason: 'ИИ не подключён — обзор строится по правилам.' };
  if (!ctx.privacy.aiTextConsent) return { eligible: false, reason: 'Нет согласия на отправку текста ИИ (Настройки → Приватность). Обзор построен по правилам.' };
  return { eligible: true, reason: 'ИИ получает только агрегированные счётчики недели — без названий дел, заметок и веса.' };
}

export function resolveWeekStart(input: string | null | undefined, ctx: UserContext, now: DateTime): LocalDate {
  const today = localDateOf(now, ctx.tz);
  const current = weekStartOf(today);
  if (input && isLocalDate(input)) {
    const ws = weekStartOf(input);
    if (ws > current) throw new AppError('FUTURE_WEEK', 'Эта неделя ещё не началась', 422);
    return ws;
  }
  return current;
}

/**
 * Monday of the first week Life OS planned for this user: the earlier of the onboarding week and the
 * first planned day (an account can start with a replayed past week; the night before onboarding —
 * a lone sleep block — does not count). Weeks before it have nothing to review. Never later than the
 * current week.
 */
export async function accountFirstWeek(tx: Tx, ctx: UserContext, now: DateTime): Promise<LocalDate> {
  const current = weekStartOf(localDateOf(now, ctx.tz));
  const [row] = await tx<{ since: Date | null; firstEvent: string | null }[]>`
    select (select coalesce(onboarded_at, created_at) from profiles where user_id = ${ctx.userId}) as since,
           (select min(local_date) from schedule_events where user_id = ${ctx.userId} and kind <> 'sleep') as first_event`;
  const starts = [row?.since ? localDateOf(row.since, ctx.tz) : null, row?.firstEvent ?? null].filter((d): d is LocalDate => !!d);
  if (!starts.length) return current;
  const first = weekStartOf(starts.sort()[0]!);
  return first < current ? first : current;
}

/** Default week for the page: on Mon/Tue the previous week is the one worth reviewing — unless it predates the account. */
export function defaultReviewWeek(ctx: UserContext, now: DateTime, firstWeek?: LocalDate): LocalDate {
  const today = localDateOf(now, ctx.tz);
  const ws = isoWeekday(today) <= 2 ? addDays(weekStartOf(today), -7) : weekStartOf(today);
  return firstWeek && ws < firstWeek ? firstWeek : ws;
}

export async function getWeeklyReview(tx: Tx, ctx: UserContext, now: DateTime, weekStart: LocalDate) {
  const [r] = await tx<ReviewRow[]>`select * from weekly_reviews where user_id = ${ctx.userId} and week_start_date = ${weekStart}`;
  const today = localDateOf(now, ctx.tz);
  const currentWeek = weekStartOf(today);
  const firstWeek = await accountFirstWeek(tx, ctx, now);
  const base = {
    weekStart,
    weekEnd: addDays(weekStart, 6),
    prevWeek: weekStart > firstWeek ? addDays(weekStart, -7) : null,
    nextWeek: addDays(weekStart, 7) <= currentWeek ? addDays(weekStart, 7) : null,
    isCurrentWeek: weekStart === currentWeek,
    today,
    /** Monday of the account's first week and its Sunday — the first day a full weekly review makes sense. */
    firstWeek,
    firstReviewDate: addDays(firstWeek, 6),
    ai: aiEligibility(ctx),
    rewards: await weekRewards(tx, ctx, weekStart),
  };
  if (!r) return { ...base, review: null };
  return {
    ...base,
    review: {
      id: r.id,
      status: r.status,
      generatedAt: r.generatedAt.toISOString(),
      confirmedAt: r.confirmedAt?.toISOString() ?? null,
      generation: r.generation,
      facts: r.factsJson.facts,
      patterns: r.factsJson.patterns,
      proposals: r.proposalsJson.map((p) => ({ ...p, decision: r.decisionsJson[p.id] ?? null })),
      aiInsights: r.aiInsightsJson,
      note: r.userNote,
    },
  };
}
export type WeeklyReviewView = Awaited<ReturnType<typeof getWeeklyReview>>;

/**
 * Upsert by (user, week_start_date). Regeneration recomputes facts, patterns and undecided
 * proposals but keeps every decision (and the decided proposals they refer to).
 */
export async function generateWeeklyReview(tx: Tx, ctx: UserContext, now: DateTime, weekStartInput?: string | null) {
  const weekStart = resolveWeekStart(weekStartInput, ctx, now);
  const facts = await computeWeekFacts(tx, ctx, now, weekStart);
  const patterns = detectPatterns(facts);
  const fresh = await buildProposals(tx, ctx, now, facts);
  await tx`select pg_advisory_xact_lock(hashtextextended(${`weekly:${ctx.userId}:${weekStart}`}, 0))`;
  const [old] = await tx<ReviewRow[]>`select * from weekly_reviews where user_id = ${ctx.userId} and week_start_date = ${weekStart} for update`;
  const decisions = old?.decisionsJson ?? {};
  const kept = (old?.proposalsJson ?? []).filter((p) => decisions[p.id]);
  const proposals = [...kept, ...fresh.filter((p) => !decisions[p.id])];
  const factsJson = { facts, patterns };
  if (old) {
    await tx`
      update weekly_reviews set facts_json = ${tx.json(factsJson as never)}, proposals_json = ${tx.json(proposals as never)},
        ai_insights_json = null, generated_at = ${now.toJSDate()}, generation = generation + 1
      where id = ${old.id}`;
  } else {
    await tx`
      insert into weekly_reviews (user_id, week_start_date, facts_json, proposals_json, status, generated_at)
      values (${ctx.userId}, ${weekStart}, ${tx.json(factsJson as never)}, ${tx.json(proposals as never)}, 'generated', ${now.toJSDate()})`;
  }
  await audit(tx, ctx.userId, 'weekly_review', weekStart, old ? 'regenerated' : 'generated', { proposals: proposals.length, patterns: patterns.length });
  if (rewardsEnabled()) {
    await syncXp(tx, ctx, now, weekStart);
    await proposeWeekRewards(tx, ctx, weekStart, {
      workoutsCompleted: facts.workouts.completed,
      confirmedBreakfastDays: facts.meals.confirmedBreakfastDays,
      reviewDone: old?.status === 'decided',
    });
  }
  return getWeeklyReview(tx, ctx, now, weekStart);
}

export const decideSchema = z.object({
  weekStart: z.string().refine(isLocalDate, 'Дата YYYY-MM-DD'),
  decisions: z.array(z.object({ proposalId: z.string().min(1).max(60), decision: z.enum(['accept', 'reject']) })).max(10).default([]),
  keepAsIs: z.boolean().default(false),
  note: z.string().trim().max(1000).nullable().optional(),
});
export type DecideInput = z.infer<typeof decideSchema>;

export interface DecideResult {
  applied: { proposalId: string; summary: string }[];
  alreadyApplied: string[];
  regenerated: { removed: number; created: number } | null;
  view: WeeklyReviewView;
}

/**
 * Apply accepted proposals atomically (one transaction — any failure rolls everything back),
 * record decisions, mark the review done. Idempotent: an applied proposal is never applied again.
 */
export async function decideWeeklyReview(tx: Tx, ctx: UserContext, now: DateTime, input: DecideInput): Promise<DecideResult> {
  const weekStart = weekStartOf(input.weekStart);
  await tx`select pg_advisory_xact_lock(hashtextextended(${`weekly:${ctx.userId}:${weekStart}`}, 0))`;
  const [r] = await tx<ReviewRow[]>`select * from weekly_reviews where user_id = ${ctx.userId} and week_start_date = ${weekStart} for update`;
  if (!r) throw new AppError('REVIEW_NOT_FOUND', 'Сначала сформируй обзор недели', 404);
  const decisions: Record<string, Decision> = { ...r.decisionsJson };
  const byId = new Map(r.proposalsJson.map((p) => [p.id, p]));
  const applied: DecideResult['applied'] = [];
  const alreadyApplied: string[] = [];
  let effect: Effect = 'none';
  let enableSnacks = false;
  const at = now.toISO()!;

  for (const d of input.decisions) {
    const p = byId.get(d.proposalId);
    if (!p) throw new AppError('PROPOSAL_NOT_FOUND', 'Предложение не найдено — обнови обзор', 404);
    const prev = decisions[p.id];
    if (prev?.applied) {
      alreadyApplied.push(p.id);
      continue;
    }
    if (d.decision === 'reject') {
      decisions[p.id] = { decision: 'rejected', decidedAt: at, applied: false, summary: null };
      continue;
    }
    const res = await applyOne(tx, ctx.userId, applySchema.parse(p.apply));
    if (res.effect === 'events' || (res.effect === 'reminders' && effect === 'none')) effect = res.effect;
    enableSnacks ||= !!res.enableSnacks;
    const summary = p.diff.map((x) => `${x.label}: ${x.from} → ${x.to}`).join('; ');
    decisions[p.id] = { decision: 'accepted', decidedAt: at, applied: true, summary };
    applied.push({ proposalId: p.id, summary });
  }
  if (input.keepAsIs) {
    for (const p of r.proposalsJson) if (!decisions[p.id]) decisions[p.id] = { decision: 'kept', decidedAt: at, applied: false, summary: null };
  }

  let regenerated: DecideResult['regenerated'] = null;
  if (effect !== 'none') {
    const fresh = await loadContext(tx, ctx.userId);
    const keys = enabledKeysOf(fresh);
    if (enableSnacks) keys.add('snacks');
    await syncTemplates(tx, ctx.userId, fresh.prefs, keys);
    const after = await loadContext(tx, ctx.userId);
    if (effect === 'events') regenerated = await regenerateFuture(tx, after, now);
    else await reconcileReminders(tx, after, now);
  }

  const allDecided = r.proposalsJson.every((p) => decisions[p.id]);
  const status = allDecided ? 'decided' : r.status;
  const note = input.note !== undefined ? input.note || null : r.userNote;
  await tx`
    update weekly_reviews set decisions_json = ${tx.json(decisions as never)}, status = ${status}, user_note = ${note},
      confirmed_at = case when ${status} = 'decided' then coalesce(confirmed_at, ${now.toJSDate()}) else confirmed_at end
    where id = ${r.id}`;
  if (applied.length || input.decisions.length || input.keepAsIs) {
    await audit(tx, ctx.userId, 'weekly_review', weekStart, 'decided', {
      applied: applied.map((a) => a.proposalId),
      rejected: input.decisions.filter((d) => d.decision === 'reject').map((d) => d.proposalId),
      keepAsIs: input.keepAsIs,
    });
  }

  if (status === 'decided' && rewardsEnabled()) {
    const doneDate = localDateOf(now, ctx.tz);
    await grantXp(tx, ctx.userId, 'weekly_review', weekStart, doneDate);
    if (note?.trim()) await grantXp(tx, ctx.userId, 'new_experience', `week:${weekStart}`, doneDate);
    const f = r.factsJson.facts;
    await proposeWeekRewards(tx, ctx, weekStart, {
      workoutsCompleted: f.workouts.completed,
      confirmedBreakfastDays: f.meals.confirmedBreakfastDays,
      reviewDone: true,
    });
  }
  const view = await getWeeklyReview(tx, await loadContext(tx, ctx.userId), now, weekStart);
  return { applied, alreadyApplied, regenerated, view };
}

// ---------------------------------------------------------------------------
// optional AI commentary — outside the DB transaction, aggregated facts only
// ---------------------------------------------------------------------------
export function aiPayload(f: WeekFacts, patterns: Pattern[]) {
  const reason = (r: { reason: string; count: number }) => ({ reason: STANDARD_REASONS.has(r.reason) ? r.reason : 'другое', count: r.count });
  return {
    week: `${f.weekStart}..${f.weekEnd}`,
    daysElapsed: f.daysElapsed,
    weekComplete: f.isComplete,
    events: f.events.byKind.map((k) => ({ kind: k.label, planned: k.planned, completed: k.completed, skipped: k.skipped, unknown: k.unknown, upcoming: k.upcoming })),
    meals: f.meals.slots.map((s) => ({ meal: s.label, plannedDays: s.plannedDays, confirmedDays: s.confirmedDays, skippedDays: s.skippedDays, unknownDays: s.unknownDays })),
    weightMeasurements: f.weight.count,
    steps: { daysWithData: f.steps.daysWithData, average: f.steps.average },
    sleepDaysWithData: f.sleep.daysWithData,
    workouts: { target: f.workouts.target, completed: f.workouts.completed, skipped: f.workouts.skipped, unknown: f.workouts.unknown },
    extraWorkMinutes: { planned: f.extraWork.plannedMinutes, confirmed: f.extraWork.actualMinutes, threshold: f.extraWork.warnAtMinutes },
    ownProjectMinutes: { planned: f.ownProject.plannedMinutes, confirmed: f.ownProject.completedMinutes, target: f.ownProject.targetMinutes },
    reminders: { sent: f.notifications.sent, answered: f.notifications.acknowledged },
    rescheduleReasons: f.reasons.reschedule.map(reason),
    skipReasons: f.reasons.skip.map(reason),
    tasks: f.tasks,
    patterns: patterns.map((p) => p.text),
    note: 'Значения null/0 дней с данными означают «нет данных», а не ноль.',
  };
}

export async function attachAiCommentary(userId: string, weekStart: LocalDate, now: DateTime): Promise<AiBlock | null> {
  const prep = await withUser(userId, async (tx) => {
    const ctx = await loadContext(tx, userId);
    const [r] = await tx<ReviewRow[]>`select * from weekly_reviews where user_id = ${userId} and week_start_date = ${weekStart}`;
    return { ctx, r };
  });
  if (!prep.r || !aiEligibility(prep.ctx).eligible) return null;
  const p = aiProvider();
  const label = 'Комментарий ИИ по фактам';
  let block: AiBlock;
  try {
    await assertAIBudget(userId);
    try {
      const res = await p.weeklyInsights(aiPayload(prep.r.factsJson.facts, prep.r.factsJson.patterns));
      await recordAIUsage(userId, p.name, 'weekly_insights', true);
      block = { source: 'ai', label, summary: res.summary, observations: res.observations, suggestions: res.suggestions, error: null, generatedAt: now.toISO()! };
    } catch (e) {
      await recordAIUsage(userId, p.name, 'weekly_insights', false);
      throw e;
    }
  } catch (e) {
    const code = e instanceof AIError ? e.code : 'ERROR';
    block = {
      source: 'rules',
      label: 'Итог по правилам (ИИ недоступен)',
      summary: null,
      observations: [],
      suggestions: [],
      error: code === 'BUDGET' ? 'Дневной лимит запросов к ИИ исчерпан.' : 'ИИ сейчас не ответил — показан итог по правилам.',
      generatedAt: now.toISO()!,
    };
  }
  await withUser(userId, (tx) => tx`
    update weekly_reviews set ai_insights_json = ${tx.json(block as never)} where user_id = ${userId} and week_start_date = ${weekStart}`);
  return block;
}
