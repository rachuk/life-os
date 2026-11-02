import type { DateTime } from 'luxon';
import { z } from 'zod';
import { addDays, dayBoundsUtc, localDateOf, weekStartOf, type LocalDate } from '@/domain/time';
import { one, type Tx } from '../db';
import { env } from '../env';
import { AppError, notFound } from '../http';
import { audit } from './audit';
import type { UserContext } from './profile';

/**
 * Rewards (PRD §14): XP for confirmed behaviours + a VIRTUAL wish fund.
 * - XP only for behaviours confirmed in the data (never weight, calories, appearance or overtime);
 *   xp_events is unique per (user, source_type, source_id), so a fact can never pay twice.
 * - Money is the user's own budget bookkeeping: the system never moves money and stores no bank
 *   details. Weekly rules create `earned` rows with status 'proposed'; the user approves them,
 *   transfers money themselves and marks them 'funded'. Monthly totals never exceed the budget.
 * - Missing data never removes what was already accumulated; corrections are explicit `adjusted` rows.
 */

export function rewardsEnabled(): boolean {
  return env().ENABLE_REWARDS;
}

// ---------------------------------------------------------------------------
// settings (routine_preferences.rewards_settings)
// ---------------------------------------------------------------------------
const cents = (max: number) => z.number().int().min(0).max(max);

export const rewardsSettingsSchema = z.object({
  currency: z.literal('EUR').default('EUR'),
  /** null = not set: the budget is the user's decision (PRD §25.2), no money is proposed without it */
  monthlyBudgetCents: cents(1_000_000).nullable().default(null),
  perWorkoutCents: cents(100_000).default(0),
  maxWorkoutsPerWeek: z.number().int().min(0).max(7).default(2),
  breakfastBonusCents: cents(100_000).default(0),
  breakfastMinDays: z.number().int().min(1).max(7).default(5),
  weeklyReviewCents: cents(100_000).default(0),
});
export type RewardsSettings = z.infer<typeof rewardsSettingsSchema>;
export const rewardsSettingsPatchSchema = rewardsSettingsSchema.omit({ currency: true }).partial();

export async function loadRewardsSettings(tx: Tx, userId: string): Promise<RewardsSettings> {
  const [r] = await tx<{ rewardsSettings: unknown }[]>`select rewards_settings from routine_preferences where user_id = ${userId}`;
  const parsed = rewardsSettingsSchema.safeParse(r?.rewardsSettings ?? {});
  return parsed.success ? parsed.data : rewardsSettingsSchema.parse({});
}

export async function updateRewardsSettings(tx: Tx, userId: string, patch: z.infer<typeof rewardsSettingsPatchSchema>): Promise<RewardsSettings> {
  assertEnabled();
  const cur = await loadRewardsSettings(tx, userId);
  const next = rewardsSettingsSchema.parse({ ...cur, ...patch });
  const rows = await tx`update routine_preferences set rewards_settings = ${tx.json(next as never)} where user_id = ${userId} returning user_id`;
  if (!rows.length) throw new AppError('NO_PREFERENCES', 'Сначала пройди первую настройку', 409);
  await audit(tx, userId, 'rewards_settings', userId, 'updated', { fields: Object.keys(patch) });
  return next;
}

function assertEnabled(): void {
  if (!rewardsEnabled()) throw new AppError('REWARDS_DISABLED', 'Награды выключены на этом сервере', 409);
}

// ---------------------------------------------------------------------------
// XP
// ---------------------------------------------------------------------------
export const XP_RULES = {
  breakfast: { points: 10, label: 'Завтрак подтверждён' },
  workout: { points: 30, label: 'Тренировка выполнена' },
  weekly_review: { points: 40, label: 'Обзор недели проведён' },
  inbox_processed: { points: 15, label: 'Входящие разобраны' },
  important_task: { points: 20, label: 'Важное личное дело сделано' },
  new_experience: { points: 25, label: 'Новое впечатление' },
  habit_plan_day: { points: 5, label: 'День в пределах плана по привычке' },
  skill_practice: { points: 5, label: 'Практика навыка' },
  skill_checkpoint: { points: 40, label: 'Контрольное задание по навыку' },
} as const;
export type XpSource = keyof typeof XP_RULES;

/** Idempotent: the same (source, id) never pays twice. Returns true when newly granted. */
export async function grantXp(tx: Tx, userId: string, source: XpSource, sourceId: string, localDate: LocalDate): Promise<boolean> {
  if (!rewardsEnabled()) return false;
  const rule = XP_RULES[source];
  const rows = await tx`
    insert into xp_events (user_id, source_type, source_id, points, reason, local_date)
    values (${userId}, ${source}, ${sourceId}, ${rule.points}, ${rule.label}, ${localDate})
    on conflict (user_id, source_type, source_id) do nothing returning id`;
  return rows.length > 0;
}

/**
 * Derive XP from confirmed facts since `since` (default: 8 weeks back). Safe to call often —
 * every grant is keyed by the underlying fact.
 */
export async function syncXp(tx: Tx, ctx: UserContext, now: DateTime, since?: LocalDate): Promise<number> {
  if (!rewardsEnabled()) return 0;
  const today = localDateOf(now, ctx.tz);
  const from = since ?? addDays(weekStartOf(today), -56);
  const fromUtc = dayBoundsUtc(from, ctx.tz).start.toJSDate();
  let granted = 0;

  const breakfasts = await tx<{ localDate: string }[]>`
    select local_date from schedule_events
    where user_id = ${ctx.userId} and kind = 'meal_breakfast' and status = 'completed' and local_date between ${from} and ${today}
    union
    select local_date from meal_logs
    where user_id = ${ctx.userId} and meal_slot = 'breakfast' and consumption_status <> 'not_eaten' and local_date between ${from} and ${today}`;
  for (const b of breakfasts) if (await grantXp(tx, ctx.userId, 'breakfast', b.localDate, b.localDate)) granted++;

  const workouts = await tx<{ key: string; localDate: string }[]>`
    select 'ev:' || id::text as key, local_date from schedule_events
    where user_id = ${ctx.userId} and kind = 'workout' and status = 'completed' and local_date between ${from} and ${today}
    union
    select case when schedule_event_id is not null then 'ev:' || schedule_event_id::text else 'ws:' || id::text end as key, local_date
    from workout_sessions
    where user_id = ${ctx.userId} and status = 'completed' and local_date between ${from} and ${today}`;
  const seen = new Set<string>();
  for (const w of workouts) {
    if (seen.has(w.key)) continue;
    seen.add(w.key);
    if (await grantXp(tx, ctx.userId, 'workout', w.key, w.localDate)) granted++;
  }

  const tasks = await tx<{ id: string; completedAt: Date }[]>`
    select id, completed_at from tasks
    where user_id = ${ctx.userId} and status = 'done' and priority = 'high' and category <> 'work_reminder'
      and completed_at is not null and completed_at >= ${fromUtc}`;
  for (const t of tasks) if (await grantXp(tx, ctx.userId, 'important_task', t.id, localDateOf(t.completedAt, ctx.tz))) granted++;

  const reviews = await tx<{ weekStartDate: string; confirmedAt: Date | null; userNote: string | null }[]>`
    select week_start_date, confirmed_at, user_note from weekly_reviews
    where user_id = ${ctx.userId} and status = 'decided' and week_start_date >= ${addDays(from, -7)}`;
  for (const r of reviews) {
    const d = r.confirmedAt ? localDateOf(r.confirmedAt, ctx.tz) : addDays(r.weekStartDate, 6);
    if (await grantXp(tx, ctx.userId, 'weekly_review', r.weekStartDate, d)) granted++;
    if (r.userNote?.trim() && (await grantXp(tx, ctx.userId, 'new_experience', `week:${r.weekStartDate}`, d))) granted++;
  }

  // habit change: finished days within the agreed limit (behaviour, not "units not used")
  const { daysWithinPlan } = await import('./habitChange');
  for (const d of await daysWithinPlan(tx, ctx, from, addDays(today, -1))) {
    if (await grantXp(tx, ctx.userId, 'habit_plan_day', d.key, d.date)) granted++;
  }
  // skills: practice sessions and passed checkpoints
  const practice = await tx<{ id: string; localDate: string }[]>`
    select id, local_date from skill_practice_logs where user_id = ${ctx.userId} and local_date between ${from} and ${today}`;
  for (const pr of practice) if (await grantXp(tx, ctx.userId, 'skill_practice', pr.id, pr.localDate)) granted++;
  const checkpoints = await tx<{ id: string; completedAt: Date }[]>`
    select id, completed_at from skill_checkpoints where user_id = ${ctx.userId} and status = 'passed' and completed_at >= ${fromUtc}`;
  for (const c of checkpoints) if (await grantXp(tx, ctx.userId, 'skill_checkpoint', c.id, localDateOf(c.completedAt, ctx.tz))) granted++;

  // inbox processed: only decidable for today (no pending items left + at least one handled today)
  const { start, end } = dayBoundsUtc(today, ctx.tz);
  const [ib] = await tx<{ pending: number; handled: number }[]>`
    select count(*) filter (where processing_status in ('received','processing','proposed','failed'))::int as pending,
           count(*) filter (where processing_status in ('confirmed','rejected','stored')
                              and updated_at >= ${start.toJSDate()} and updated_at < ${end.toJSDate()})::int as handled
    from inbox_items where user_id = ${ctx.userId}`;
  if (ib && ib.pending === 0 && ib.handled > 0 && (await grantXp(tx, ctx.userId, 'inbox_processed', today, today))) granted++;
  return granted;
}

/** Level n starts at 50·(n−1)·n XP: 0, 100, 300, 600, 1000, … */
export function levelFor(xp: number): { level: number; currentFloor: number; nextAt: number } {
  let n = 1;
  while (50 * n * (n + 1) <= xp) n++;
  return { level: n, currentFloor: 50 * (n - 1) * n, nextAt: 50 * n * (n + 1) };
}

export interface Achievement {
  key: string;
  title: string;
  description: string;
  achieved: boolean;
  progress: { current: number; target: number };
}

interface XpRow {
  sourceType: XpSource;
  sourceId: string;
  points: number;
  reason: string;
  localDate: string;
  createdAt: Date;
}

export function achievementsFrom(rows: Pick<XpRow, 'sourceType' | 'localDate'>[]): Achievement[] {
  const total = (s: XpSource) => rows.filter((r) => r.sourceType === s).length;
  const maxPerWeek = (s: XpSource) => {
    const m = new Map<string, number>();
    for (const r of rows) if (r.sourceType === s) m.set(weekStartOf(r.localDate), (m.get(weekStartOf(r.localDate)) ?? 0) + 1);
    return Math.max(0, ...m.values());
  };
  const a = (key: string, title: string, description: string, current: number, target: number): Achievement => ({
    key,
    title,
    description,
    achieved: current >= target,
    progress: { current: Math.min(current, target), target },
  });
  return [
    a('first_breakfast', 'Первый завтрак', 'Подтвердить завтрак хотя бы раз', total('breakfast'), 1),
    a('breakfast_week', 'Неделя с завтраками', '5 подтверждённых завтраков за одну неделю', maxPerWeek('breakfast'), 5),
    a('two_workouts', 'Две тренировки за неделю', 'Выполнить две тренировки в одной неделе', maxPerWeek('workout'), 2),
    a('ten_workouts', '10 тренировок', 'Всего выполненных тренировок', total('workout'), 10),
    a('first_review', 'Первый обзор недели', 'Провести обзор недели и принять решения', total('weekly_review'), 1),
    a('inbox_zero', 'Входящие разобраны', 'Разобрать все входящие за день', total('inbox_processed'), 1),
    a('important_task', 'Важное личное дело', 'Закрыть дело с высоким приоритетом', total('important_task'), 1),
    a('new_experience', 'Новое впечатление', 'Записать в обзоре недели, что было новым или приятным', total('new_experience'), 1),
  ];
}

// ---------------------------------------------------------------------------
// virtual fund: ledger
// ---------------------------------------------------------------------------
export interface LedgerRow {
  id: string;
  goalId: string | null;
  periodKey: string;
  entryType: 'earned' | 'approved' | 'funded' | 'redeemed' | 'adjusted';
  amountCents: number;
  status: 'proposed' | 'approved' | 'rejected' | 'funded' | 'redeemed' | 'final';
  originKey: string;
  notes: string | null;
  weekStart: string | null;
  ruleKey: string | null;
  basisJson: Record<string, unknown>;
  createdAt: Date;
  statusChangedAt: Date | null;
}

export function serializeLedger(r: LedgerRow) {
  return {
    id: r.id,
    goalId: r.goalId,
    periodKey: r.periodKey,
    entryType: r.entryType,
    amountCents: r.amountCents,
    status: r.status,
    originKey: r.originKey,
    notes: r.notes,
    weekStart: r.weekStart,
    ruleKey: r.ruleKey,
    basis: r.basisJson,
    createdAt: r.createdAt.toISOString(),
    statusChangedAt: r.statusChangedAt?.toISOString() ?? null,
  };
}
export type SerializedLedger = ReturnType<typeof serializeLedger>;

/** Budget month of a week: the month of its Thursday (deterministic, like ISO weeks). */
export function monthKeyOfWeek(weekStart: LocalDate): string {
  return addDays(weekStart, 3).slice(0, 7);
}

async function lockMonth(tx: Tx, userId: string, month: string): Promise<void> {
  await tx`select pg_advisory_xact_lock(hashtextextended(${`rewards:${userId}:${month}`}, 0))`;
}

/** Virtual amount counted against the month budget: earned (not rejected) + adjustments. */
export async function monthUsedCents(tx: Tx, userId: string, month: string, excludeOriginKey?: string): Promise<number> {
  const [r] = await tx<{ used: number }[]>`
    select coalesce(sum(amount_cents), 0)::int as used from reward_ledger
    where user_id = ${userId} and period_key = ${month}
      and ((entry_type = 'earned' and status <> 'rejected') or entry_type = 'adjusted')
      and (${excludeOriginKey ?? null}::text is null or origin_key <> ${excludeOriginKey ?? null})`;
  return Math.max(0, r?.used ?? 0);
}

export interface WeekRewardFacts {
  workoutsCompleted: number;
  confirmedBreakfastDays: number;
  reviewDone: boolean;
}

export interface WeekRewardsResult {
  status: 'disabled' | 'no_budget' | 'ok';
  month: string;
  entries: SerializedLedger[];
  capped: { ruleKey: string; computedCents: number; grantedCents: number }[];
}

/**
 * Create/refresh the week's proposed `earned` rows (REV-04, REV-05). Idempotent by origin_key;
 * a still-proposed row may grow when new facts arrive, but never shrinks and never duplicates.
 */
export async function proposeWeekRewards(tx: Tx, ctx: UserContext, weekStart: LocalDate, f: WeekRewardFacts): Promise<WeekRewardsResult> {
  const month = monthKeyOfWeek(weekStart);
  const listWeek = async () =>
    (await tx<LedgerRow[]>`select * from reward_ledger where user_id = ${ctx.userId} and week_start = ${weekStart} order by created_at`).map(serializeLedger);
  if (!rewardsEnabled()) return { status: 'disabled', month, entries: [], capped: [] };
  const s = await loadRewardsSettings(tx, ctx.userId);
  if (s.monthlyBudgetCents === null) return { status: 'no_budget', month, entries: await listWeek(), capped: [] };

  await lockMonth(tx, ctx.userId, month);
  const counted = Math.min(f.workoutsCompleted, s.maxWorkoutsPerWeek);
  const rules = [
    {
      key: 'workouts',
      amount: counted * s.perWorkoutCents,
      basis: { workoutsCompleted: f.workoutsCompleted, counted, perWorkoutCents: s.perWorkoutCents, maxPerWeek: s.maxWorkoutsPerWeek },
      note: `Тренировки: ${counted} × ${euro(s.perWorkoutCents)} (учитывается не больше ${s.maxWorkoutsPerWeek} в неделю)`,
    },
    {
      key: 'breakfasts',
      amount: f.confirmedBreakfastDays >= s.breakfastMinDays ? s.breakfastBonusCents : 0,
      basis: { confirmedBreakfastDays: f.confirmedBreakfastDays, minDays: s.breakfastMinDays, bonusCents: s.breakfastBonusCents },
      note: `Завтраки: подтверждено ${f.confirmedBreakfastDays} дн. (условие — от ${s.breakfastMinDays})`,
    },
    {
      key: 'review',
      amount: f.reviewDone ? s.weeklyReviewCents : 0,
      basis: { reviewDone: f.reviewDone, cents: s.weeklyReviewCents },
      note: 'Проведён обзор недели',
    },
  ];
  const capped: WeekRewardsResult['capped'] = [];
  for (const rule of rules) {
    if (rule.amount <= 0) continue;
    const originKey = `week:${weekStart}:${rule.key}`;
    const [existing] = await tx<LedgerRow[]>`select * from reward_ledger where user_id = ${ctx.userId} and origin_key = ${originKey} for update`;
    const used = await monthUsedCents(tx, ctx.userId, month, originKey);
    const allowed = Math.max(0, s.monthlyBudgetCents - used);
    const amount = Math.min(rule.amount, allowed);
    if (amount < rule.amount) capped.push({ ruleKey: rule.key, computedCents: rule.amount, grantedCents: Math.max(amount, existing?.amountCents ?? 0) });
    const basis = { ...rule.basis, computedCents: rule.amount, cappedByBudget: amount < rule.amount, budgetCents: s.monthlyBudgetCents };
    if (existing) {
      if (existing.status === 'proposed' && amount > existing.amountCents) {
        await tx`update reward_ledger set amount_cents = ${amount}, basis_json = ${tx.json(basis as never)}, notes = ${rule.note}
                 where id = ${existing.id}`;
      }
      continue;
    }
    if (amount <= 0) continue;
    // the month lock + `for update` above make a conflict impossible; `do nothing` is a last guard
    const [row] = await tx<LedgerRow[]>`
      insert into reward_ledger (user_id, period_key, entry_type, amount_cents, status, origin_key, notes, week_start, rule_key, basis_json)
      values (${ctx.userId}, ${month}, 'earned', ${amount}, 'proposed', ${originKey}, ${rule.note}, ${weekStart}, ${rule.key}, ${tx.json(basis as never)})
      on conflict (user_id, origin_key) do nothing returning *`;
    if (row) await audit(tx, ctx.userId, 'reward_ledger', row.id, 'proposed', { rule: rule.key, amountCents: amount });
  }
  return { status: 'ok', month, entries: await listWeek(), capped };
}

export function euro(cents: number): string {
  const v = cents / 100;
  return `€${Number.isInteger(v) ? v : v.toFixed(2)}`;
}

const ids = z.array(z.string().uuid()).min(1).max(50);
export const ledgerActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('approve'), entryIds: ids }),
  z.object({ action: z.literal('reject'), entryIds: ids }),
  z.object({ action: z.literal('fund'), entryIds: ids, goalId: z.string().uuid().nullable().optional() }),
  z.object({
    action: z.literal('redeem'),
    goalId: z.string().uuid(),
    amountCents: z.number().int().min(0).max(100_000_000).optional(),
    note: z.string().trim().max(300).nullable().optional(),
  }),
  z.object({
    action: z.literal('adjust'),
    amountCents: z.number().int().min(-1_000_000).max(1_000_000).refine((v) => v !== 0, 'Сумма не может быть нулевой'),
    note: z.string().trim().min(1, 'Укажи причину корректировки').max(300),
    idempotencyKey: z.string().trim().min(8).max(80),
  }),
]);
export type LedgerAction = z.infer<typeof ledgerActionSchema>;

const TRANSITIONS: Record<'approve' | 'reject' | 'fund', { from: LedgerRow['status'][]; to: LedgerRow['status'] }> = {
  approve: { from: ['proposed'], to: 'approved' },
  reject: { from: ['proposed'], to: 'rejected' },
  fund: { from: ['approved'], to: 'funded' },
};

export async function applyLedgerAction(tx: Tx, ctx: UserContext, now: DateTime, input: LedgerAction): Promise<{ changed: number; skipped: number; message: string }> {
  assertEnabled();
  if (input.action === 'approve' || input.action === 'reject' || input.action === 'fund') {
    const t = TRANSITIONS[input.action];
    let goalId: string | null = null;
    if (input.action === 'fund' && input.goalId) {
      const [g] = await tx`select id from reward_goals where id = ${input.goalId} and user_id = ${ctx.userId} and status = 'active'`;
      if (!g) throw notFound('Цель');
      goalId = input.goalId;
    }
    const rows = await tx<LedgerRow[]>`
      update reward_ledger set status = ${t.to}, status_changed_at = ${now.toJSDate()},
        goal_id = case when ${input.action} = 'fund' then coalesce(${goalId}::uuid, goal_id) else goal_id end
      where user_id = ${ctx.userId} and id = any(${input.entryIds}) and entry_type = 'earned' and status = any(${t.from})
      returning *`;
    for (const r of rows) await audit(tx, ctx.userId, 'reward_ledger', r.id, input.action, { to: t.to, amountCents: r.amountCents, goalId });
    const messages = { approve: 'Начисление подтверждено', reject: 'Начисление отклонено', fund: 'Отмечено: деньги отложены' };
    return { changed: rows.length, skipped: input.entryIds.length - rows.length, message: rows.length ? messages[input.action] : 'Уже отмечено' };
  }

  const month = localDateOf(now, ctx.tz).slice(0, 7);
  if (input.action === 'redeem') {
    const [g] = await tx<{ id: string; title: string; status: string }[]>`
      select id, title, status from reward_goals where id = ${input.goalId} and user_id = ${ctx.userId} for update`;
    if (!g) throw notFound('Цель');
    const originKey = `redeem:${g.id}`;
    const [already] = await tx`select id from reward_ledger where user_id = ${ctx.userId} and origin_key = ${originKey}`;
    if (already || g.status === 'redeemed') return { changed: 0, skipped: 1, message: 'Цель уже отмечена купленной' };
    const [f] = await tx<{ funded: number }[]>`
      select coalesce(sum(amount_cents), 0)::int as funded from reward_ledger
      where user_id = ${ctx.userId} and goal_id = ${g.id} and status = 'funded'`;
    const amount = input.amountCents ?? f?.funded ?? 0;
    const row = one(await tx<LedgerRow[]>`
      insert into reward_ledger (user_id, goal_id, period_key, entry_type, amount_cents, status, origin_key, notes)
      values (${ctx.userId}, ${g.id}, ${month}, 'redeemed', ${amount}, 'redeemed', ${originKey}, ${input.note ?? `Куплено: ${g.title}`})
      returning *`);
    await tx`update reward_goals set status = 'redeemed' where id = ${g.id}`;
    await audit(tx, ctx.userId, 'reward_goal', g.id, 'redeemed', { amountCents: amount, ledgerId: row.id });
    return { changed: 1, skipped: 0, message: 'Покупка отмечена — поздравляю!' };
  }

  // adjust: correcting entry (PRD §14.4); positive corrections still respect the month budget
  const originKey = `adjust:${input.idempotencyKey}`;
  await lockMonth(tx, ctx.userId, month);
  const [already] = await tx`select id from reward_ledger where user_id = ${ctx.userId} and origin_key = ${originKey}`;
  if (already) return { changed: 0, skipped: 1, message: 'Корректировка уже записана' };
  if (input.amountCents > 0) {
    const s = await loadRewardsSettings(tx, ctx.userId);
    if (s.monthlyBudgetCents === null) throw new AppError('NO_BUDGET', 'Сначала задай месячный бюджет наград', 422);
    const used = await monthUsedCents(tx, ctx.userId, month);
    if (used + input.amountCents > s.monthlyBudgetCents) {
      throw new AppError('BUDGET_EXCEEDED', `Превысит месячный бюджет: осталось ${euro(Math.max(0, s.monthlyBudgetCents - used))}`, 422);
    }
  }
  const row = one(await tx<LedgerRow[]>`
    insert into reward_ledger (user_id, period_key, entry_type, amount_cents, status, origin_key, notes)
    values (${ctx.userId}, ${month}, 'adjusted', ${input.amountCents}, 'final', ${originKey}, ${input.note})
    returning *`);
  await audit(tx, ctx.userId, 'reward_ledger', row.id, 'adjusted', { amountCents: input.amountCents });
  return { changed: 1, skipped: 0, message: 'Корректировка записана' };
}

// ---------------------------------------------------------------------------
// wish goals
// ---------------------------------------------------------------------------
const link = z
  .string()
  .trim()
  .max(500)
  .refine((v) => /^https?:\/\//i.test(v), 'Ссылка должна начинаться с http:// или https://');

export const goalInputSchema = z.object({
  title: z.string().trim().min(1, 'Название обязательно').max(200),
  targetAmountCents: z.number().int().min(0).max(100_000_000),
  priority: z.number().int().min(0).max(10).default(0),
  link: link.nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export const goalPatchSchema = goalInputSchema.partial().extend({ status: z.enum(['active', 'archived']).optional() });

export interface GoalRow {
  id: string;
  title: string;
  targetAmountCents: number;
  currency: string;
  priority: number;
  status: 'active' | 'redeemed' | 'archived';
  link: string | null;
  notes: string | null;
  createdAt: Date;
}

export async function createGoal(tx: Tx, userId: string, input: z.infer<typeof goalInputSchema>) {
  assertEnabled();
  const row = one(await tx<GoalRow[]>`
    insert into reward_goals (user_id, title, target_amount_cents, priority, link, notes)
    values (${userId}, ${input.title}, ${input.targetAmountCents}, ${input.priority}, ${input.link ?? null}, ${input.notes ?? null})
    returning id, title, target_amount_cents, currency, priority, status, link, notes, created_at`);
  await audit(tx, userId, 'reward_goal', row.id, 'created', { targetAmountCents: input.targetAmountCents });
  return row;
}

export async function updateGoal(tx: Tx, userId: string, id: string, patch: z.infer<typeof goalPatchSchema>) {
  assertEnabled();
  const [cur] = await tx<GoalRow[]>`select * from reward_goals where id = ${id} and user_id = ${userId}`;
  if (!cur) throw notFound('Цель');
  if (cur.status === 'redeemed' && patch.status) throw new AppError('GOAL_REDEEMED', 'Цель уже куплена — её статус не меняется', 409);
  const row = one(await tx<GoalRow[]>`
    update reward_goals set
      title = ${patch.title ?? cur.title},
      target_amount_cents = ${patch.targetAmountCents ?? cur.targetAmountCents},
      priority = ${patch.priority ?? cur.priority},
      link = ${patch.link !== undefined ? patch.link : cur.link},
      notes = ${patch.notes !== undefined ? patch.notes : cur.notes},
      status = ${patch.status ?? cur.status}
    where id = ${id} and user_id = ${userId}
    returning id, title, target_amount_cents, currency, priority, status, link, notes, created_at`);
  await audit(tx, userId, 'reward_goal', id, 'updated', { fields: Object.keys(patch) });
  return row;
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
export interface RewardsSummary {
  enabled: boolean;
  xp: { total: number; level: number; currentFloor: number; nextAt: number; thisWeek: number; recent: { reason: string; points: number; localDate: string }[] };
  achievements: Achievement[];
  settings: RewardsSettings;
  budget: { month: string; budgetCents: number | null; usedCents: number; remainingCents: number | null };
  totals: { proposedCents: number; approvedCents: number; fundedCents: number; redeemedCents: number; adjustedCents: number; availableFundedCents: number };
  goals: (Omit<GoalRow, 'createdAt'> & { createdAt: string; fundedCents: number; progress: number })[];
  unallocatedFundedCents: number;
  ledger: SerializedLedger[];
}

export async function rewardsSummary(tx: Tx, ctx: UserContext, now: DateTime): Promise<RewardsSummary> {
  const enabled = rewardsEnabled();
  const settings = await loadRewardsSettings(tx, ctx.userId);
  const today = localDateOf(now, ctx.tz);
  const month = today.slice(0, 7);
  if (enabled) await syncXp(tx, ctx, now);

  const xpRows = await tx<XpRow[]>`
    select source_type, source_id, points, reason, local_date, created_at from xp_events
    where user_id = ${ctx.userId} order by local_date desc, created_at desc`;
  const total = xpRows.reduce((s, r) => s + r.points, 0);
  const ws = weekStartOf(today);
  const thisWeek = xpRows.filter((r) => r.localDate >= ws && r.localDate <= addDays(ws, 6)).reduce((s, r) => s + r.points, 0);

  const ledgerRows = await tx<LedgerRow[]>`select * from reward_ledger where user_id = ${ctx.userId} order by created_at desc limit 200`;
  const [agg] = await tx<{ proposed: number; approved: number; funded: number; redeemed: number; adjusted: number }[]>`
    select
      coalesce(sum(amount_cents) filter (where entry_type = 'earned' and status = 'proposed'), 0)::int as proposed,
      coalesce(sum(amount_cents) filter (where entry_type = 'earned' and status = 'approved'), 0)::int as approved,
      coalesce(sum(amount_cents) filter (where status = 'funded'), 0)::int as funded,
      coalesce(sum(amount_cents) filter (where entry_type = 'redeemed'), 0)::int as redeemed,
      coalesce(sum(amount_cents) filter (where entry_type = 'adjusted'), 0)::int as adjusted
    from reward_ledger where user_id = ${ctx.userId}`;
  const goals = await tx<(GoalRow & { fundedCents: number })[]>`
    select g.id, g.title, g.target_amount_cents, g.currency, g.priority, g.status, g.link, g.notes, g.created_at,
      coalesce((select sum(l.amount_cents) from reward_ledger l where l.goal_id = g.id and l.status = 'funded'), 0)::int as funded_cents
    from reward_goals g where g.user_id = ${ctx.userId} and g.status <> 'archived'
    order by g.status = 'redeemed', g.priority desc, g.created_at`;
  const [unalloc] = await tx<{ n: number }[]>`
    select coalesce(sum(amount_cents), 0)::int as n from reward_ledger where user_id = ${ctx.userId} and status = 'funded' and goal_id is null`;
  const used = await monthUsedCents(tx, ctx.userId, month);
  const t = agg ?? { proposed: 0, approved: 0, funded: 0, redeemed: 0, adjusted: 0 };

  return {
    enabled,
    xp: {
      total,
      ...levelFor(total),
      thisWeek,
      recent: xpRows.slice(0, 12).map((r) => ({ reason: r.reason, points: r.points, localDate: r.localDate })),
    },
    achievements: achievementsFrom(xpRows),
    settings,
    budget: {
      month,
      budgetCents: settings.monthlyBudgetCents,
      usedCents: used,
      remainingCents: settings.monthlyBudgetCents === null ? null : Math.max(0, settings.monthlyBudgetCents - used),
    },
    totals: {
      proposedCents: t.proposed,
      approvedCents: t.approved,
      fundedCents: t.funded,
      redeemedCents: t.redeemed,
      adjustedCents: t.adjusted,
      availableFundedCents: Math.max(0, t.funded - t.redeemed),
    },
    goals: goals.map((g) => ({
      ...g,
      createdAt: g.createdAt.toISOString(),
      progress: g.targetAmountCents > 0 ? Math.min(1, g.fundedCents / g.targetAmountCents) : 0,
    })),
    unallocatedFundedCents: unalloc?.n ?? 0,
    ledger: ledgerRows.map(serializeLedger),
  };
}

/** Week slice for the weekly review page. */
export async function weekRewards(tx: Tx, ctx: UserContext, weekStart: LocalDate) {
  const enabled = rewardsEnabled();
  const settings = await loadRewardsSettings(tx, ctx.userId);
  const entries = (await tx<LedgerRow[]>`select * from reward_ledger where user_id = ${ctx.userId} and week_start = ${weekStart} order by created_at`).map(serializeLedger);
  const xp = await tx<{ reason: string; points: number; localDate: string }[]>`
    select reason, points, local_date from xp_events
    where user_id = ${ctx.userId} and local_date between ${weekStart} and ${addDays(weekStart, 6)} order by local_date, created_at`;
  return {
    enabled,
    budgetSet: settings.monthlyBudgetCents !== null,
    month: monthKeyOfWeek(weekStart),
    entries,
    xpPoints: xp.reduce((s, r) => s + r.points, 0),
    xp,
  };
}
