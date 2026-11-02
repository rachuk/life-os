import type { DateTime } from 'luxon';
import { addDays, weekDates, zoned } from '@/domain/time';
import type { Tx } from '../db';
import { currentPlanVersion, ensureMaterialized, loadEventRows, serializeEvent, weekProgress, type SerializedEvent } from '../services/planning';
import type { UserContext } from '../services/profile';

export interface WeekData {
  weekStart: string;
  days: { date: string; events: SerializedEvent[] }[];
  progress: Awaited<ReturnType<typeof weekProgress>>;
  planVersion: number;
  risks: { title: string; message: string }[];
  versions: { id: string; version: number; source: string; summary: string | null; status: string; createdAt: string; actor: string }[];
}

export async function getWeekData(tx: Tx, ctx: UserContext, now: DateTime, weekStart: string): Promise<WeekData> {
  const { risks } = await ensureMaterialized(tx, ctx, now, weekStart, addDays(weekStart, 6));
  const rows = await loadEventRows(tx, ctx.userId, zoned(weekStart, '00:00', ctx.tz), zoned(addDays(weekStart, 7), '00:00', ctx.tz));
  const versions = await tx<{ id: string; version: number; source: string; summary: string | null; status: string; createdAt: Date; actor: string }[]>`
    select id, version, source, summary, status, created_at, actor from plan_versions
    where user_id = ${ctx.userId} and week_start = ${weekStart} order by version desc limit 12`;
  return {
    weekStart,
    days: weekDates(weekStart).map((d) => ({
      date: d,
      events: rows.filter((r) => r.localDate === d).map(serializeEvent),
    })),
    progress: await weekProgress(tx, ctx, weekStart),
    planVersion: await currentPlanVersion(tx, ctx.userId, weekStart),
    risks: risks.map((r) => ({ title: r.title, message: r.message })),
    versions: versions.map((v) => ({ ...v, createdAt: v.createdAt.toISOString() })),
  };
}
