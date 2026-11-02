import type { DateTime } from 'luxon';
import { z } from 'zod';
import {
  DEFAULT_ALTERNATIVES,
  DEFAULT_REASONS,
  baselineStatus,
  detectHabitPatterns,
  savings,
  scheduledLimit,
  suggestedStartLimit,
  summarizeDays,
  weekProgress,
  type HabitEvent,
} from '@/domain/habits/change';
import { addDays, isLocalDate, localDateOf, weekStartOf, zoned, type LocalDate } from '@/domain/time';
import { one, type Tx } from '../db';
import { AppError, notFound } from '../http';
import { audit } from './audit';
import type { UserContext } from './profile';

export interface ProgramRow {
  id: string;
  key: string;
  title: string;
  unitLabel: string;
  direction: 'reduce' | 'quit';
  phase: 'baseline' | 'reducing' | 'quit' | 'paused';
  baselineStartedOn: string;
  baselineDays: number;
  baselinePerDay: number | null;
  dailyLimit: number | null;
  stepPerWeek: number;
  limitSetOn: string | null;
  quitDate: string | null;
  pricePerUnitCents: number | null;
  currency: string;
  reasons: string[];
  alternatives: string[];
  showOnToday: boolean;
  enabled: boolean;
}

export const programSetupSchema = z.object({
  title: z.string().trim().min(1).max(80),
  unitLabel: z.string().trim().min(1).max(30).default('раз'),
  baselineDays: z.number().int().min(3).max(28).default(7),
  stepPerWeek: z.number().int().min(0).max(10).default(1),
  pricePerPackCents: z.number().int().min(0).max(100000).nullable().optional(),
  unitsPerPack: z.number().int().min(1).max(500).nullable().optional(),
  reasons: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  alternatives: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  showOnToday: z.boolean().default(true),
});

export const programPatchSchema = z.object({
  title: z.string().trim().min(1).max(80).optional(),
  unitLabel: z.string().trim().min(1).max(30).optional(),
  pricePerPackCents: z.number().int().min(0).max(100000).nullable().optional(),
  unitsPerPack: z.number().int().min(1).max(500).nullable().optional(),
  reasons: z.array(z.string().trim().min(1).max(40)).max(12).optional(),
  alternatives: z.array(z.string().trim().min(1).max(60)).max(10).optional(),
  showOnToday: z.boolean().optional(),
  stepPerWeek: z.number().int().min(0).max(10).optional(),
  phase: z.enum(['baseline', 'reducing', 'quit', 'paused']).optional(),
});

function slug(title: string): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/giu, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return s || 'habit';
}

function pricePerUnit(pack: number | null | undefined, units: number | null | undefined): number | null {
  if (pack === null || pack === undefined || !units) return null;
  return Math.round(pack / units);
}

export async function listPrograms(tx: Tx, userId: string): Promise<ProgramRow[]> {
  return tx<ProgramRow[]>`select * from habit_change_programs where user_id = ${userId} and enabled order by created_at`;
}

export async function getProgram(tx: Tx, userId: string, id: string): Promise<ProgramRow> {
  const [p] = await tx<ProgramRow[]>`select * from habit_change_programs where id = ${id} and user_id = ${userId}`;
  if (!p) throw new AppError('NOT_FOUND', 'Программа не найдена', 404);
  return p;
}

export async function createProgram(tx: Tx, ctx: UserContext, now: DateTime, raw: z.input<typeof programSetupSchema>): Promise<ProgramRow> {
  const input = programSetupSchema.parse(raw);
  let key = slug(input.title);
  const [exists] = await tx<{ n: number }[]>`select count(*)::int as n from habit_change_programs where user_id = ${ctx.userId} and key like ${key + '%'}`;
  if (exists && exists.n > 0) key = `${key}-${exists.n + 1}`;
  const row = one(
    await tx<ProgramRow[]>`
      insert into habit_change_programs (user_id, key, title, unit_label, baseline_started_on, baseline_days, step_per_week,
        price_per_unit_cents, reasons, alternatives, show_on_today)
      values (${ctx.userId}, ${key}, ${input.title}, ${input.unitLabel}, ${localDateOf(now, ctx.tz)}, ${input.baselineDays},
        ${input.stepPerWeek}, ${pricePerUnit(input.pricePerPackCents, input.unitsPerPack)},
        ${tx.json((input.reasons ?? DEFAULT_REASONS) as never)}, ${tx.json((input.alternatives ?? DEFAULT_ALTERNATIVES) as never)},
        ${input.showOnToday})
      returning *`,
  );
  await audit(tx, ctx.userId, 'habit_change_program', row.id, 'created', { title: row.title });
  return row;
}

export async function updateProgram(tx: Tx, ctx: UserContext, id: string, raw: z.input<typeof programPatchSchema>): Promise<ProgramRow> {
  const patch = programPatchSchema.parse(raw);
  const cur = await getProgram(tx, ctx.userId, id);
  const price =
    patch.pricePerPackCents !== undefined || patch.unitsPerPack !== undefined
      ? pricePerUnit(patch.pricePerPackCents ?? null, patch.unitsPerPack ?? null)
      : cur.pricePerUnitCents;
  const row = one(
    await tx<ProgramRow[]>`
      update habit_change_programs set
        title = ${patch.title ?? cur.title}, unit_label = ${patch.unitLabel ?? cur.unitLabel},
        price_per_unit_cents = ${price}, reasons = ${tx.json((patch.reasons ?? cur.reasons) as never)},
        alternatives = ${tx.json((patch.alternatives ?? cur.alternatives) as never)},
        show_on_today = ${patch.showOnToday ?? cur.showOnToday}, step_per_week = ${patch.stepPerWeek ?? cur.stepPerWeek},
        phase = ${patch.phase ?? cur.phase}
      where id = ${id} and user_id = ${ctx.userId} returning *`,
  );
  return row;
}

export async function archiveProgram(tx: Tx, ctx: UserContext, id: string): Promise<void> {
  await getProgram(tx, ctx.userId, id);
  await tx`update habit_change_programs set enabled = false where id = ${id} and user_id = ${ctx.userId}`;
  await audit(tx, ctx.userId, 'habit_change_program', id, 'archived', {});
}

/** Current daily limit or null while observing / paused. */
export function currentLimit(p: ProgramRow, today: LocalDate): number | null {
  if (p.phase === 'paused' || p.phase === 'baseline') return null;
  if (p.direction === 'quit' && p.quitDate && today >= p.quitDate) return 0;
  if (p.dailyLimit === null || !p.limitSetOn) return null;
  return scheduledLimit(p.dailyLimit, p.limitSetOn, today, p.stepPerWeek);
}

async function eventContext(tx: Tx, ctx: UserContext, now: DateTime): Promise<{ duringWork: boolean; duringExtraWork: boolean }> {
  const rows = await tx<{ kind: string }[]>`
    select kind from schedule_events
    where user_id = ${ctx.userId} and kind in ('work', 'extra_work') and status not in ('cancelled', 'skipped')
      and start_at <= ${now.toJSDate()} and end_at > ${now.toJSDate()}`;
  return { duringWork: rows.some((r) => r.kind === 'work'), duringExtraWork: rows.some((r) => r.kind === 'extra_work') };
}

export const logSchema = z.object({
  kind: z.enum(['use', 'urge_resisted']).default('use'),
  quantity: z.number().int().min(1).max(20).default(1),
  reason: z.string().trim().max(60).nullable().optional(),
  note: z.string().trim().max(300).nullable().optional(),
});

export interface LoggedEvent {
  id: string;
  todayTotal: number;
  limit: number | null;
  program: ProgramRow;
}

export async function logHabitEvent(
  tx: Tx,
  ctx: UserContext,
  now: DateTime,
  programId: string,
  raw: z.input<typeof logSchema>,
  source: 'web' | 'telegram' = 'web',
): Promise<LoggedEvent> {
  const input = logSchema.parse(raw);
  const program = await getProgram(tx, ctx.userId, programId);
  if (!program.enabled) throw new AppError('ARCHIVED', 'Программа в архиве', 409);
  const today = localDateOf(now, ctx.tz);
  const context = await eventContext(tx, ctx, now);
  const row = one(
    await tx<{ id: string }[]>`
      insert into habit_change_events (user_id, program_id, kind, occurred_at, local_date, quantity, reason, context, source, note)
      values (${ctx.userId}, ${programId}, ${input.kind}, ${now.toJSDate()}, ${today}, ${input.quantity}, ${input.reason ?? null},
              ${tx.json(context)}, ${source}, ${input.note ?? null})
      returning id`,
  );
  return { id: row.id, todayTotal: await dayTotal(tx, ctx.userId, programId, today), limit: currentLimit(program, today), program };
}

export async function dayTotal(tx: Tx, userId: string, programId: string, date: LocalDate): Promise<number> {
  const [r] = await tx<{ uses: number; total: number | null }[]>`
    select coalesce(sum(quantity) filter (where kind = 'use'), 0)::int as uses,
           max(quantity) filter (where kind = 'day_total') as total
    from habit_change_events where user_id = ${userId} and program_id = ${programId} and local_date = ${date}`;
  return r?.total ?? r?.uses ?? 0;
}

export async function setEventReason(tx: Tx, userId: string, eventId: string, reason: string | null): Promise<void> {
  const rows = await tx`update habit_change_events set reason = ${reason?.slice(0, 60) ?? null}
                        where id = ${eventId} and user_id = ${userId} and kind <> 'day_total' returning id`;
  if (!rows.length) throw notFound('Отметка');
}

export async function deleteHabitEvent(tx: Tx, userId: string, eventId: string): Promise<void> {
  const rows = await tx`delete from habit_change_events where id = ${eventId} and user_id = ${userId} returning id`;
  if (!rows.length) throw notFound('Отметка');
}

export const dayTotalSchema = z.object({
  date: z.string().refine(isLocalDate),
  total: z.number().int().min(0).max(200).nullable(),
});

/** End-of-day correction: «итог дня» overrides the per-use sum (null removes it). */
export async function setDayTotal(tx: Tx, ctx: UserContext, now: DateTime, programId: string, raw: z.input<typeof dayTotalSchema>): Promise<void> {
  const { date, total } = dayTotalSchema.parse(raw);
  await getProgram(tx, ctx.userId, programId);
  if (date > localDateOf(now, ctx.tz)) throw new AppError('FUTURE_DATE', 'Нельзя указать итог за будущий день', 422);
  await tx`delete from habit_change_events where program_id = ${programId} and user_id = ${ctx.userId} and local_date = ${date} and kind = 'day_total'`;
  if (total !== null) {
    await tx`insert into habit_change_events (user_id, program_id, kind, occurred_at, local_date, quantity, source)
             values (${ctx.userId}, ${programId}, 'day_total', ${zoned(date, '23:59', ctx.tz).toJSDate()}, ${date}, ${total}, 'web')`;
  }
}

export const startPlanSchema = z.object({
  direction: z.enum(['reduce', 'quit']).default('reduce'),
  dailyLimit: z.number().int().min(0).max(200),
  stepPerWeek: z.number().int().min(0).max(10).default(1),
  quitDate: z.string().refine(isLocalDate).nullable().optional(),
});

/** Move from observation to a plan. The user confirms the starting limit and the weekly step. */
export async function startPlan(tx: Tx, ctx: UserContext, now: DateTime, programId: string, raw: z.input<typeof startPlanSchema>): Promise<ProgramRow> {
  const input = startPlanSchema.parse(raw);
  const p = await getProgram(tx, ctx.userId, programId);
  const today = localDateOf(now, ctx.tz);
  const events = await loadEvents(tx, ctx, programId, p.baselineStartedOn, today);
  const base = baselineStatus(summarizeDays(events, p.baselineStartedOn, today), p.baselineStartedOn, today, p.baselineDays);
  const row = one(
    await tx<ProgramRow[]>`
      update habit_change_programs set direction = ${input.direction}, phase = ${input.direction === 'quit' ? 'quit' : 'reducing'},
        daily_limit = ${input.dailyLimit}, step_per_week = ${input.stepPerWeek}, limit_set_on = ${today},
        baseline_per_day = coalesce(baseline_per_day, ${base.perDay}), quit_date = ${input.quitDate ?? null}
      where id = ${programId} and user_id = ${ctx.userId} returning *`,
  );
  await audit(tx, ctx.userId, 'habit_change_program', programId, 'plan_started', { limit: input.dailyLimit, step: input.stepPerWeek, direction: input.direction });
  return row;
}

interface EventRow {
  kind: 'use' | 'urge_resisted' | 'day_total';
  localDate: string;
  occurredAt: Date;
  quantity: number;
  reason: string | null;
  context: { duringWork?: boolean; duringExtraWork?: boolean };
}

async function loadEvents(tx: Tx, ctx: UserContext, programId: string, from: LocalDate, to: LocalDate): Promise<HabitEvent[]> {
  const rows = await tx<EventRow[]>`
    select kind, local_date, occurred_at, quantity, reason, context from habit_change_events
    where user_id = ${ctx.userId} and program_id = ${programId} and local_date between ${from} and ${to}`;
  return rows.map((r) => ({
    kind: r.kind,
    localDate: r.localDate,
    localHour: Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone: ctx.tz }).format(r.occurredAt)) % 24,
    quantity: r.quantity,
    reason: r.reason,
    duringWork: !!r.context?.duringWork,
    duringExtraWork: !!r.context?.duringExtraWork,
  }));
}

async function extraWorkDates(tx: Tx, userId: string, from: LocalDate, to: LocalDate): Promise<Set<LocalDate>> {
  const rows = await tx<{ localDate: string }[]>`
    select distinct local_date from schedule_events
    where user_id = ${userId} and kind = 'extra_work' and status <> 'cancelled' and local_date between ${from} and ${to}`;
  return new Set(rows.map((r) => r.localDate));
}

export async function programOverview(tx: Tx, ctx: UserContext, now: DateTime, programId: string) {
  const p = await getProgram(tx, ctx.userId, programId);
  const today = localDateOf(now, ctx.tz);
  const from = addDays(today, -27);
  const start = p.baselineStartedOn < from ? from : p.baselineStartedOn;
  const events = await loadEvents(tx, ctx, programId, addDays(today, -55) < p.baselineStartedOn ? p.baselineStartedOn : addDays(today, -55), today);
  const days = summarizeDays(events, start, today);
  const allDays = summarizeDays(events, p.baselineStartedOn < addDays(today, -55) ? addDays(today, -55) : p.baselineStartedOn, today);
  const base = baselineStatus(allDays, p.baselineStartedOn, today, p.baselineDays);
  const basePerDay = p.baselinePerDay ?? base.perDay;
  const ws = weekStartOf(today);
  const week = weekProgress(
    summarizeDays(events, ws, addDays(ws, 6)).map((d) => (d.date > today ? { ...d, total: null } : d)),
    (d) => (d > today ? null : currentLimit(p, d)),
  );
  const todayEvents = await tx<{ id: string; kind: string; quantity: number; reason: string | null; occurredAt: Date }[]>`
    select id, kind, quantity, reason, occurred_at from habit_change_events
    where user_id = ${ctx.userId} and program_id = ${programId} and local_date = ${today} order by occurred_at desc`;
  const sinceLimit = p.limitSetOn ? allDays.filter((d) => d.date >= p.limitSetOn! && d.date <= today) : [];
  return {
    program: p,
    today,
    todayTotal: days.find((d) => d.date === today)?.total ?? null,
    todayResisted: days.find((d) => d.date === today)?.resisted ?? 0,
    limit: currentLimit(p, today),
    nextWeekLimit: p.phase === 'reducing' && p.dailyLimit !== null && p.limitSetOn ? scheduledLimit(p.dailyLimit, p.limitSetOn, addDays(today, 7), p.stepPerWeek) : null,
    baseline: { ...base, perDay: basePerDay, suggestedLimit: basePerDay !== null ? suggestedStartLimit(basePerDay, p.stepPerWeek || 1) : null },
    week,
    // always 28 calendar days; days before the program started are «нет данных», not zero
    days28: summarizeDays(events, from, today).map((d) => ({ date: d.date, total: d.total, limit: currentLimit(p, d.date) })),
    todayEvents: todayEvents.map((e) => ({ ...e, occurredAt: e.occurredAt.toISOString() })),
    reasonsWeek: Object.entries(
      events
        .filter((e) => e.kind === 'use' && e.localDate >= ws && e.reason)
        .reduce<Record<string, number>>((acc, e) => ({ ...acc, [e.reason!]: (acc[e.reason!] ?? 0) + e.quantity }), {}),
    ).sort((a, b) => b[1] - a[1]),
    patterns: detectHabitPatterns(events.filter((e) => e.localDate >= from), days, await extraWorkDates(tx, ctx.userId, from, today), p.unitLabel),
    savings: savings(sinceLimit, basePerDay, p.pricePerUnitCents),
  };
}
export type ProgramOverview = Awaited<ReturnType<typeof programOverview>>;

/** Compact facts for the weekly review (aggregates only). */
export async function weekHabitFacts(tx: Tx, ctx: UserContext, weekStart: LocalDate) {
  const programs = await listPrograms(tx, ctx.userId);
  const out = [];
  const weekEnd = addDays(weekStart, 6);
  for (const p of programs) {
    const events = await loadEvents(tx, ctx, p.id, weekStart, weekEnd);
    const days = summarizeDays(events, weekStart, weekEnd);
    const wp = weekProgress(days, (d) => currentLimit(p, d));
    out.push({
      id: p.id,
      title: p.title,
      unit: p.unitLabel,
      phase: p.phase,
      daysWithData: 7 - wp.unknown,
      average: wp.average,
      withinLimit: wp.withinLimit,
      overLimit: wp.overLimit,
      patterns: detectHabitPatterns(events, days, await extraWorkDates(tx, ctx.userId, weekStart, weekEnd), p.unitLabel),
    });
  }
  return out;
}

/** Days within the limit during an active plan (for XP: behaviour, not abstinence counts). */
export async function daysWithinPlan(tx: Tx, ctx: UserContext, from: LocalDate, to: LocalDate): Promise<{ key: string; date: LocalDate }[]> {
  const programs = await listPrograms(tx, ctx.userId);
  const out: { key: string; date: LocalDate }[] = [];
  for (const p of programs) {
    if (p.phase !== 'reducing' && p.phase !== 'quit') continue;
    const start = p.limitSetOn && p.limitSetOn > from ? p.limitSetOn : from;
    const events = await loadEvents(tx, ctx, p.id, start, to);
    for (const d of summarizeDays(events, start, to)) {
      const limit = currentLimit(p, d.date);
      if (d.total !== null && limit !== null && d.total <= limit) out.push({ key: `${p.id}:${d.date}`, date: d.date });
    }
  }
  return out;
}
