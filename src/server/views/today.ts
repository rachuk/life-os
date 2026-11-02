import { DateTime } from 'luxon';
import { computeNow, type NowAction, type NowMode } from '@/domain/planner/now';
import { eveningReviewTime } from '@/domain/planner/prefs';
import { addDays, isLocalDate, localDateOf, weekStartOf } from '@/domain/time';
import type { Tx } from '../db';
import { daySummary } from '../services/health';
import { dayEvents, ensureMaterialized, serializeEvent, toPlanEvent, weekProgress, type SerializedEvent } from '../services/planning';
import type { UserContext } from '../services/profile';

export interface TodayData {
  date: string;
  isToday: boolean;
  nowIso: string;
  tz: string;
  events: SerializedEvent[];
  now: {
    mode: NowMode;
    headline: string;
    subline: string | null;
    currentId: string | null;
    nextIds: string[];
    actions: NowAction[];
    pendingIds: string[];
  };
  meals: { planned: number; confirmed: number; skipped: number; open: number };
  health: Awaited<ReturnType<typeof daySummary>>;
  progress: Awaited<ReturnType<typeof weekProgress>>;
  inboxPending: number;
  tomorrowConfirmed: boolean;
  eveningReviewDone: boolean;
  telegramConnected: boolean;
  isOnboarded: boolean;
}

export async function getTodayData(tx: Tx, ctx: UserContext, now: DateTime, dateParam?: string | null): Promise<TodayData> {
  const today = localDateOf(now, ctx.tz);
  const date = dateParam && isLocalDate(dateParam) ? dateParam : today;
  await ensureMaterialized(tx, ctx, now, today, addDays(weekStartOf(today), 6 + (localDateOf(now, ctx.tz) >= addDays(weekStartOf(today), 4) ? 7 : 0)));
  const rows = await dayEvents(tx, ctx, date);
  const plan = rows.map(toPlanEvent);
  const nowState = computeNow({
    now: date === today ? now : DateTime.fromISO(`${date}T00:00`, { zone: ctx.tz }).toUTC(),
    tz: ctx.tz,
    events: plan,
    workoutLeadMinutes: ctx.prefs.notifications.workoutLeadMinutes + (ctx.prefs.gymTravelMinutes ?? 0),
    eveningReviewTime: eveningReviewTime(ctx.prefs),
  });
  const meals = rows.filter((r) => ['meal_breakfast', 'meal_lunch', 'meal_dinner'].includes(r.kind));
  const [inbox] = await tx<{ n: number }[]>`
    select count(*)::int as n from inbox_items where user_id = ${ctx.userId} and processing_status = 'proposed'`;
  const [tomorrow] = await tx<{ status: string }[]>`
    select status from day_plans where user_id = ${ctx.userId} and local_date = ${addDays(today, 1)}`;
  const [todayPlan] = await tx<{ eveningReviewedAt: Date | null; eveningReviewSkipped: boolean }[]>`
    select evening_reviewed_at, evening_review_skipped from day_plans where user_id = ${ctx.userId} and local_date = ${today}`;
  const [tg] = await tx<{ n: number }[]>`select count(*)::int as n from telegram_connections where user_id = ${ctx.userId} and is_active`;
  return {
    date,
    isToday: date === today,
    nowIso: now.toISO()!,
    tz: ctx.tz,
    events: rows.map(serializeEvent),
    now: {
      mode: nowState.mode,
      headline: nowState.headline,
      subline: nowState.subline,
      currentId: nowState.current?.id ?? null,
      nextIds: nowState.next.map((e) => e.id),
      actions: nowState.actions,
      pendingIds: nowState.pendingDecisions.map((e) => e.id),
    },
    meals: {
      planned: meals.filter((m) => m.status !== 'cancelled').length,
      confirmed: meals.filter((m) => m.status === 'completed').length,
      skipped: meals.filter((m) => m.status === 'skipped').length,
      open: meals.filter((m) => !['completed', 'skipped', 'cancelled'].includes(m.status)).length,
    },
    health: await daySummary(tx, ctx.userId, date),
    progress: await weekProgress(tx, ctx, weekStartOf(date)),
    inboxPending: inbox?.n ?? 0,
    tomorrowConfirmed: !!tomorrow && tomorrow.status !== 'draft',
    eveningReviewDone: !!todayPlan && (!!todayPlan.eveningReviewedAt || todayPlan.eveningReviewSkipped),
    telegramConnected: (tg?.n ?? 0) > 0,
    isOnboarded: ctx.profile.isOnboarded,
  };
}
