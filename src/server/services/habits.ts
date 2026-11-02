import type { DateTime } from 'luxon';
import { z } from 'zod';
import { addDays, isLocalDate, localDateOf, weekDates, type LocalDate } from '@/domain/time';
import { one, type Tx } from '../db';
import { AppError, notFound } from '../http';
import { audit } from './audit';
import type { UserContext } from './profile';

export interface HabitRow {
  id: string;
  key: string;
  name: string;
  type: string;
  scheduleRule: Record<string, unknown>;
  target: number | null;
  unit: string | null;
  strictness: string;
  enabled: boolean;
  trackingMode: string;
  sortOrder: number;
}

export async function listHabits(tx: Tx, userId: string) {
  return tx<HabitRow[]>`select id, key, name, type, schedule_rule, target, unit, strictness, enabled, tracking_mode, sort_order
                        from habit_definitions where user_id = ${userId} order by sort_order`;
}

export const checkinSchema = z.object({
  habitId: z.string().uuid(),
  localDate: z.string().refine(isLocalDate),
  status: z.enum(['done', 'partial', 'skipped', 'exception']),
  value: z.number().nullable().optional(),
  reason: z.string().trim().max(300).nullable().optional(),
});

export async function upsertCheckin(tx: Tx, userId: string, input: z.infer<typeof checkinSchema>, source = 'manual') {
  const [h] = await tx`select id from habit_definitions where id = ${input.habitId} and user_id = ${userId}`;
  if (!h) throw notFound('Привычка');
  const row = one(await tx<{ id: string; status: string }[]>`
    insert into habit_checkins (user_id, habit_id, local_date, status, value, source, confirmed_at, reason)
    values (${userId}, ${input.habitId}, ${input.localDate}, ${input.status}, ${input.value ?? null}, ${source}, now(), ${input.reason ?? null})
    on conflict (user_id, habit_id, local_date) do update set status = excluded.status, value = excluded.value,
      source = excluded.source, confirmed_at = now(), reason = excluded.reason
    returning id, status`);
  await audit(tx, userId, 'habit_checkin', row.id, 'upsert', { status: input.status }, source);
  return row;
}

export async function deleteCheckin(tx: Tx, userId: string, habitId: string, localDate: LocalDate) {
  await tx`delete from habit_checkins where user_id = ${userId} and habit_id = ${habitId} and local_date = ${localDate}`;
}

export async function checkinsForRange(tx: Tx, userId: string, from: LocalDate, to: LocalDate) {
  return tx<{ habitId: string; localDate: string; status: string; value: number | null; reason: string | null }[]>`
    select habit_id, local_date, status, value, reason from habit_checkins
    where user_id = ${userId} and local_date between ${from} and ${to}`;
}

export async function setHabitEnabled(tx: Tx, userId: string, habitId: string, enabled: boolean, target?: number | null) {
  const rows = await tx`update habit_definitions set enabled = ${enabled}, target = coalesce(${target ?? null}, target)
                        where id = ${habitId} and user_id = ${userId} returning id`;
  if (!rows.length) throw notFound('Привычка');
}

/** Check-in from the health screen: never for a future day; "exception" keeps its reason. */
export async function recordCheckin(tx: Tx, ctx: UserContext, now: DateTime, input: z.infer<typeof checkinSchema>, source = 'manual') {
  const today = localDateOf(now, ctx.tz);
  if (input.localDate > today) throw new AppError('FUTURE_DATE', 'Отметить можно только прошедший или сегодняшний день', 422);
  return upsertCheckin(tx, ctx.userId, { ...input, reason: input.reason?.trim() || null }, source);
}

export const habitPatchSchema = z.object({
  habitId: z.string().uuid(),
  enabled: z.boolean(),
  target: z.number().min(0).max(1_000_000).nullable().optional(),
});

/** Definitions + check-ins of one week; a day without a check-in is unknown, not "missed". */
export async function habitsWeek(tx: Tx, userId: string, weekStart: LocalDate) {
  const habits = await listHabits(tx, userId);
  const checkins = await checkinsForRange(tx, userId, weekStart, addDays(weekStart, 6));
  return {
    weekStart,
    days: weekDates(weekStart),
    habits: habits.map((h) => ({ ...h, target: h.target === null ? null : Number(h.target) })),
    checkins,
  };
}
