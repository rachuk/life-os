import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withUser } from '@/server/db';
import { AppError } from '@/server/http';
import { putStoredFile } from '@/server/storage/files';
import { loadContext } from '@/server/services/profile';
import { createManualEvent, transitionEvent } from '@/server/services/planning';
import { createTask } from '@/server/services/tasks';
import { acceptTomorrow, keepTomorrow, saveEveningReview, tomorrowDraft } from '@/server/services/review';
import { accountFirstWeek, attachAiCommentary, computeWeekFacts, decideWeeklyReview, defaultReviewWeek, generateWeeklyReview, getWeeklyReview } from '@/server/services/weeklyReview';
import { setAIProvider, type AIProvider } from '@/server/ai/provider';
import { applyLedgerAction, rewardsSummary, updateRewardsSettings } from '@/server/services/rewards';
import { deleteAllUserData, exportUserData, healthMeasurementsCsv } from '@/server/services/dataRights';
import { count, onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const at = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toUTC();
const SETUP = at('2026-11-01T20:00');
const SUNDAY_EVENING = at('2026-11-08T20:00');
const WEEK = '2026-11-02';

const ctxOf = (tx: Parameters<typeof loadContext>[0], id: string) => loadContext(tx, id);
const run = <T>(id: string, fn: (tx: Parameters<typeof loadContext>[0], ctx: Awaited<ReturnType<typeof loadContext>>) => Promise<T>) =>
  withUser(id, async (tx) => fn(tx, await ctxOf(tx, id)));

async function addMeasurement(userId: string, metric: string, value: number, localDate: string, measuredAtIso: string, unit = 'шагов') {
  await withSystem((tx) => tx`
    insert into health_measurements (user_id, metric_type, value, unit, measured_at, local_date, source_type, user_confirmed_at)
    values (${userId}, ${metric}, ${value}, ${unit}, ${at(measuredAtIso).toJSDate()}, ${localDate}, 'manual', now())`);
}

async function completeWeekWorkouts(userId: string, from = WEEK, to = '2026-11-08') {
  await withSystem((tx) => tx`
    update schedule_events set status = 'completed', status_changed_at = start_at
    where user_id = ${userId} and kind = 'workout' and local_date between ${from} and ${to}`);
}

describe('REV-01: the local week Mon 2 – Sun 8 Nov never includes 9 Nov', () => {
  let u: string;
  beforeAll(async () => {
    u = await onboardUser('rev01', SETUP);
    await addMeasurement(u, 'steps', 5000, '2026-11-08', '2026-11-08T23:30');
    await addMeasurement(u, 'steps', 20000, '2026-11-09', '2026-11-09T00:30');
    await addMeasurement(u, 'weight', 80.4, '2026-11-08', '2026-11-08T08:00', 'кг');
    await addMeasurement(u, 'weight', 99.9, '2026-11-09', '2026-11-09T08:00', 'кг');
    await completeWeekWorkouts(u, '2026-11-05', '2026-11-05');
    // a completed workout and a sent+acknowledged reminder on Monday 9 Nov (next week)
    await run(u, async (tx, ctx) => {
      const ev = await createManualEvent(tx, ctx, at('2026-11-09T07:00'), {
        date: '2026-11-09', startTime: '08:00', durationMinutes: 60, title: 'Утренняя тренировка', kind: 'workout', priorityClass: 'flexible',
      });
      await tx`update schedule_events set status = 'completed' where id = ${ev.event.id}`;
      await tx`insert into notification_outbox (user_id, event_id, channel, kind, reminder_type, message_key, scheduled_at, sent_at, status, acknowledged_at)
               values (${u}, ${ev.event.id}, 'in_app', 'important', 'start', ${`test|${ev.event.id}`}, ${at('2026-11-09T00:30').toJSDate()},
                       ${at('2026-11-09T00:30').toJSDate()}, 'acknowledged', ${at('2026-11-09T00:40').toJSDate()})`;
      await tx`insert into meal_logs (user_id, local_date, meal_slot, eaten_at, consumption_status)
               values (${u}, '2026-11-09', 'breakfast', ${at('2026-11-09T08:30').toJSDate()}, 'all')`;
    });
  });

  it('counts only rows whose local date is 2–8 Nov', async () => {
    const f = await run(u, (tx, ctx) => computeWeekFacts(tx, ctx, at('2026-11-10T12:00'), WEEK));
    expect(f.weekStart).toBe('2026-11-02');
    expect(f.weekEnd).toBe('2026-11-08');
    expect(f.isComplete).toBe(true);
    expect(f.steps.daysWithData).toBe(1);
    expect(f.steps.average).toBe(5000);
    expect(f.weight.count).toBe(1);
    expect(f.weight.values.map((v) => v.date)).toEqual(['2026-11-08']);
    expect(f.workouts.completed).toBe(1); // Thu 5 Nov only, not Mon 9 Nov
    expect(f.notifications.sent).toBe(0); // the 9 Nov 00:30 reminder is outside [2 Nov 00:00, 9 Nov 00:00)
    expect(f.meals.confirmedBreakfastDays).toBe(0);
    const evDates = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from schedule_events where user_id = ${u} and local_date = '2026-11-09'`);
    expect(evDates[0]!.n).toBeGreaterThan(0); // 9 Nov data exists, it is just excluded
  });
});

describe('REV-02: empty tables → "no data", never invented zeros', () => {
  let u: string;
  beforeAll(async () => {
    u = await onboardUser('rev02', SETUP);
  });

  it('reports missing weight / steps / workouts honestly', async () => {
    const view = await run(u, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    const f = view.review!.facts;
    expect(f.weight.count).toBe(0);
    expect(f.weight.average).toBeNull();
    expect(f.weight.change).toBeNull();
    expect(f.steps.daysWithData).toBe(0);
    expect(f.steps.average).toBeNull();
    expect(f.sleep.averageMinutes).toBeNull();
    expect(f.energy.average).toBeNull();
    expect(f.workouts.completed).toBe(0);
    expect(f.workouts.manualSessions).toBe(0);
    expect(f.meals.anyData).toBe(false);
    expect(f.notifications.rate).toBeNull();
    expect(f.summaryLines.join('\n')).toMatch(/Вес: измерений нет — нет данных/);
    expect(f.summaryLines.join('\n')).toMatch(/Шаги: нет данных/);
    expect(view.review!.patterns.find((p) => p.key === 'workouts_below_target')).toBeUndefined();
    // unanswered past events are "unknown", not "skipped"
    expect(f.events.total.skipped).toBe(0);
    expect(f.events.total.unknown).toBeGreaterThan(0);
    // nothing about steps or weight is proposed without data
    expect(view.review!.proposals.find((p) => p.id === 'steps_goal')).toBeUndefined();
    expect(view.review!.patterns.find((p) => /Вес|Шаги/.test(p.text))).toBeUndefined();
  });

  it('a week with no plan at all does not report "0 из 2" workouts', async () => {
    const f = await run(u, (tx, ctx) => computeWeekFacts(tx, ctx, SUNDAY_EVENING, '2026-10-19'));
    expect(f.workouts.planned).toBe(0);
    expect(f.summaryLines.join('\n')).toMatch(/Тренировки: в плане не было и отметок нет — нет данных/);
    expect(f.summaryLines.join('\n')).toMatch(/События: в плане недели нет событий — нет данных/);
  });

  it('weight trend needs ≥3 points', async () => {
    await addMeasurement(u, 'weight', 81, '2026-11-03', '2026-11-03T08:00', 'кг');
    await addMeasurement(u, 'weight', 80.6, '2026-11-05', '2026-11-05T08:00', 'кг');
    let f = await run(u, (tx, ctx) => computeWeekFacts(tx, ctx, SUNDAY_EVENING, WEEK));
    expect(f.weight.enough).toBe(false);
    expect(f.weight.average).toBeNull();
    await addMeasurement(u, 'weight', 80.2, '2026-11-07', '2026-11-07T08:00', 'кг');
    f = await run(u, (tx, ctx) => computeWeekFacts(tx, ctx, SUNDAY_EVENING, WEEK));
    expect(f.weight.enough).toBe(true);
    expect(f.weight.average).toBe(80.6);
    expect(f.weight.change).toBe(-0.8);
  });
});

describe('REV-03: proposals are shown with a diff and applied only by decide', () => {
  let u: string;
  beforeAll(async () => {
    u = await onboardUser('rev03', SETUP);
    // lunch was pushed later on three work days
    for (const [date, to] of [['2026-11-02', '13:30'], ['2026-11-03', '13:45'], ['2026-11-04', '13:30']] as const) {
      await run(u, async (tx, ctx) => {
        const [lunch] = await tx<{ id: string; revision: number }[]>`
          select id, revision from schedule_events where user_id = ${u} and kind = 'meal_lunch' and local_date = ${date}`;
        await transitionEvent(tx, ctx, at(`${date}T09:00`), lunch!.id, { action: 'reschedule', toDate: date, toTime: to, reason: 'Созвон' });
      });
    }
  });

  it('generate proposes a later lunch but changes nothing', async () => {
    const view = await run(u, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    const r = view.review!;
    expect(r.patterns.some((p) => p.key === 'lunch_late')).toBe(true);
    const p = r.proposals.find((x) => x.id === 'lunch_shift')!;
    expect(p).toBeDefined();
    expect(p.apply).toMatchObject({ type: 'meal_time', from: '13:00', to: '13:30' });
    expect(p.diff[0]).toMatchObject({ from: '13:00–13:45', to: '13:30–14:15' });
    expect(p.affects.events).toBeGreaterThan(0);
    expect(r.facts.reasons.reschedule).toEqual([{ reason: 'Созвон', count: 3 }]);
    // not applied automatically
    const ctx = await run(u, async (_tx, c) => c);
    expect(ctx.prefs.meals.lunch.start).toBe('13:00');
    const [future] = await withSystem((tx) => tx<{ startAt: Date }[]>`
      select start_at from schedule_events where user_id = ${u} and kind = 'meal_lunch' and local_date = '2026-11-10'`);
    expect(DateTime.fromJSDate(future!.startAt).setZone(tz).toFormat('HH:mm')).toBe('13:00');
  });

  it('decide applies the accepted change to future untouched events, once', async () => {
    const pastMoved = await withSystem((tx) => tx<{ startAt: Date }[]>`
      select start_at from schedule_events where user_id = ${u} and kind = 'meal_lunch' and local_date = '2026-11-03'`);
    const res = await run(u, (tx, ctx) =>
      decideWeeklyReview(tx, ctx, SUNDAY_EVENING, { weekStart: WEEK, decisions: [{ proposalId: 'lunch_shift', decision: 'accept' }], keepAsIs: true, note: null }),
    );
    expect(res.applied.map((a) => a.proposalId)).toEqual(['lunch_shift']);
    expect(res.applied[0]!.summary).toContain('13:00–13:45 → 13:30–14:15');
    expect(res.regenerated).not.toBeNull();
    expect(res.view.review!.status).toBe('decided');
    const ctx = await run(u, async (_tx, c) => c);
    expect(ctx.prefs.meals.lunch.start).toBe('13:30');
    expect(ctx.templates.find((t) => t.key === 'lunch_workday')!.localStart).toBe('13:30');
    const [future] = await withSystem((tx) => tx<{ startAt: Date }[]>`
      select start_at from schedule_events where user_id = ${u} and kind = 'meal_lunch' and local_date = '2026-11-10'`);
    expect(DateTime.fromJSDate(future!.startAt).setZone(tz).toFormat('HH:mm')).toBe('13:30');
    // the past, user-moved lunch is untouched
    const pastAfter = await withSystem((tx) => tx<{ startAt: Date }[]>`
      select start_at from schedule_events where user_id = ${u} and kind = 'meal_lunch' and local_date = '2026-11-03'`);
    expect(pastAfter[0]!.startAt.toISOString()).toBe(pastMoved[0]!.startAt.toISOString());

    const versions = await count('select count(*) as n from plan_versions where user_id = $1', u);
    const again = await run(u, (tx, ctx) =>
      decideWeeklyReview(tx, ctx, SUNDAY_EVENING, { weekStart: WEEK, decisions: [{ proposalId: 'lunch_shift', decision: 'accept' }], keepAsIs: false, note: null }),
    );
    expect(again.applied).toEqual([]);
    expect(again.alreadyApplied).toEqual(['lunch_shift']);
    expect(await count('select count(*) as n from plan_versions where user_id = $1', u)).toBe(versions);
    const ctx2 = await run(u, async (_tx, c) => c);
    expect(ctx2.prefs.meals.lunch.start).toBe('13:30');
  });

  it('regeneration keeps decisions and does not re-propose an applied change', async () => {
    const view = await run(u, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    const lunch = view.review!.proposals.filter((p) => p.id === 'lunch_shift');
    expect(lunch).toHaveLength(1);
    expect(lunch[0]!.decision?.applied).toBe(true);
    expect(view.review!.generation).toBe(2);
  });

  it('a stale proposal is refused (409) instead of overwriting a newer setting', async () => {
    const u2 = await onboardUser('rev03b', SETUP);
    for (const date of ['2026-11-02', '2026-11-03']) {
      await run(u2, async (tx, ctx) => {
        const [lunch] = await tx<{ id: string }[]>`select id from schedule_events where user_id = ${u2} and kind = 'meal_lunch' and local_date = ${date}`;
        await transitionEvent(tx, ctx, at(`${date}T09:00`), lunch!.id, { action: 'reschedule', toDate: date, toTime: '13:30', reason: null });
      });
    }
    await run(u2, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    await withSystem((tx) => tx`update routine_preferences set meal_windows = jsonb_set(meal_windows, '{lunch,start}', '"12:45"') where user_id = ${u2}`);
    const err = await run(u2, (tx, ctx) =>
      decideWeeklyReview(tx, ctx, SUNDAY_EVENING, { weekStart: WEEK, decisions: [{ proposalId: 'lunch_shift', decision: 'accept' }], keepAsIs: false, note: null }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('PROPOSAL_STALE');
  });
});

describe('REV-04 / REV-05: virtual rewards within budget, never duplicated', () => {
  let u: string;
  beforeAll(async () => {
    u = await onboardUser('rev04', SETUP);
    await completeWeekWorkouts(u); // Tue 3 + Thu 5 Nov
    await run(u, (tx) =>
      updateRewardsSettings(tx, u, { monthlyBudgetCents: 1000, perWorkoutCents: 600, maxWorkoutsPerWeek: 2, breakfastBonusCents: 500, breakfastMinDays: 5, weeklyReviewCents: 300 }),
    );
  });

  const earnedSum = () =>
    count("select coalesce(sum(amount_cents),0) as n from reward_ledger where user_id = $1 and period_key = '2026-11' and entry_type = 'earned' and status <> 'rejected'", u);

  it('caps the month at the budget and only proposes (no transfer)', async () => {
    const view = await run(u, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    expect(view.review!.facts.workouts.completed).toBe(2);
    const entries = view.rewards.entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ ruleKey: 'workouts', amountCents: 1000, status: 'proposed', entryType: 'earned', periodKey: '2026-11' });
    expect(entries[0]!.basis).toMatchObject({ computedCents: 1200, cappedByBudget: true });
    expect(await earnedSum()).toBeLessThanOrEqual(1000);
    // nothing leaves the system: no external calls, nothing "funded" without the user
    expect(await count('select count(*) as n from external_api_usage where user_id = $1', u)).toBe(0);
    expect(await count("select count(*) as n from reward_ledger where user_id = $1 and status = 'funded'", u)).toBe(0);
  });

  it('REV-05: generate twice and accept twice → still one entry per rule and one XP per fact', async () => {
    await run(u, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    const xpBefore = await count('select count(*) as n from xp_events where user_id = $1', u);
    const decide = () => run(u, (tx, ctx) => decideWeeklyReview(tx, ctx, SUNDAY_EVENING, { weekStart: WEEK, decisions: [], keepAsIs: true, note: 'Новый маршрут прогулки' }));
    await decide();
    await decide();
    await run(u, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    const rows = await withSystem((tx) => tx<{ originKey: string; n: number }[]>`
      select origin_key, count(*)::int as n from reward_ledger where user_id = ${u} group by origin_key`);
    expect(rows.every((r) => r.n === 1)).toBe(true);
    // the review bonus would exceed the budget → not created at all
    expect(rows.map((r) => r.originKey).sort()).toEqual(['week:2026-11-02:workouts']);
    expect(await earnedSum()).toBe(1000);
    const xp = await withSystem((tx) => tx<{ sourceType: string; n: number }[]>`
      select source_type, count(*)::int as n from xp_events where user_id = ${u} group by source_type order by 1`);
    expect(xp.find((x) => x.sourceType === 'weekly_review')?.n).toBe(1);
    expect(xp.find((x) => x.sourceType === 'new_experience')?.n).toBe(1);
    expect(xp.find((x) => x.sourceType === 'workout')?.n).toBe(2);
    expect(await count('select count(*) as n from xp_events where user_id = $1', u)).toBe(xpBefore + 2);

    const [entry] = await withSystem((tx) => tx<{ id: string }[]>`select id from reward_ledger where user_id = ${u}`);
    const a1 = await run(u, (tx, ctx) => applyLedgerAction(tx, ctx, SUNDAY_EVENING, { action: 'approve', entryIds: [entry!.id] }));
    const a2 = await run(u, (tx, ctx) => applyLedgerAction(tx, ctx, SUNDAY_EVENING, { action: 'approve', entryIds: [entry!.id] }));
    expect([a1.changed, a2.changed]).toEqual([1, 0]);
    expect(await count('select count(*) as n from reward_ledger where user_id = $1', u)).toBe(1);
  });

  it('positive adjustments respect the budget; missing data never removes amounts', async () => {
    const err = await run(u, (tx, ctx) => applyLedgerAction(tx, ctx, SUNDAY_EVENING, { action: 'adjust', amountCents: 100, note: 'бонус', idempotencyKey: 'adj-test-0001' })).catch((e) => e);
    expect((err as AppError).code).toBe('BUDGET_EXCEEDED');
    // facts disappear (workouts reopened) → the approved amount stays
    await withSystem((tx) => tx`update schedule_events set status = 'planned' where user_id = ${u} and kind = 'workout'`);
    await run(u, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    expect(await earnedSum()).toBe(1000);
    const s = await run(u, (tx, ctx) => rewardsSummary(tx, ctx, SUNDAY_EVENING));
    expect(s.budget).toMatchObject({ month: '2026-11', budgetCents: 1000, usedCents: 1000, remainingCents: 0 });
    expect(s.totals.approvedCents).toBe(1000);
    expect(s.xp.total).toBeGreaterThan(0);
  });

  it('without a budget no money is proposed at all', async () => {
    const v = await onboardUser('rev04b', SETUP);
    await completeWeekWorkouts(v);
    const view = await run(v, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    expect(view.rewards.budgetSet).toBe(false);
    expect(await count('select count(*) as n from reward_ledger where user_id = $1', v)).toBe(0);
  });
});

describe('evening review and plan for tomorrow', () => {
  let u: string;
  const MON_EVENING = at('2026-11-02T22:30');
  beforeAll(async () => {
    u = await onboardUser('evening', SETUP);
    await run(u, (tx, ctx) => createTask(tx, ctx, { title: 'Позвонить в банк', type: 'task', category: 'finance', priority: 'high', dueDate: '2026-11-03', estimatedMinutes: 30 }));
  });

  it('saves the answers, checks in the habit and never marks anything done by itself', async () => {
    await run(u, (tx, ctx) => saveEveningReview(tx, ctx, MON_EVENING, { date: '2026-11-02', wins: 'Обед вовремя', blockers: null, workedInBed: false, energy: 3 }));
    const [plan] = await withSystem((tx) => tx<{ eveningReviewedAt: Date | null; eveningReviewJson: { energy: number } }[]>`
      select evening_reviewed_at, evening_review_json from day_plans where user_id = ${u} and local_date = '2026-11-02'`);
    expect(plan!.eveningReviewedAt).not.toBeNull();
    expect(plan!.eveningReviewJson.energy).toBe(3);
    const [c] = await withSystem((tx) => tx<{ status: string }[]>`
      select c.status from habit_checkins c join habit_definitions h on h.id = c.habit_id
      where c.user_id = ${u} and h.key = 'no_work_in_bed' and c.local_date = '2026-11-02'`);
    expect(c!.status).toBe('done');
    expect(await count("select count(*) as n from schedule_events where user_id = $1 and local_date = '2026-11-02' and status = 'completed'", u)).toBe(0);
  });

  it('drafts tomorrow with sources and a free slot; accept is idempotent; keep moves nothing', async () => {
    const draft = await run(u, (tx, ctx) => tomorrowDraft(tx, ctx, MON_EVENING, '2026-11-03'));
    const s = draft.suggestions.find((x) => x.title === 'Позвонить в банк')!;
    expect(s.source).toBe('due');
    expect(s.slot).not.toBeNull();
    expect(draft.status).toBe('draft');
    const before = await count('select count(*) as n from schedule_events where user_id = $1', u);
    const input = { date: '2026-11-03', confirmDay: true, items: [{ id: s.id, startTime: s.slot!.startTime, durationMinutes: s.durationMinutes }] };
    const r1 = await run(u, (tx, ctx) => acceptTomorrow(tx, ctx, MON_EVENING, input));
    const r2 = await run(u, (tx, ctx) => acceptTomorrow(tx, ctx, MON_EVENING, input));
    expect(r1.created).toBe(1);
    expect(r2.created).toBe(0);
    expect(await count('select count(*) as n from schedule_events where user_id = $1', u)).toBe(before + 1);
    const after = await run(u, (tx, ctx) => tomorrowDraft(tx, ctx, MON_EVENING, '2026-11-03'));
    expect(after.status).toBe('confirmed');
    expect(after.suggestions.find((x) => x.title === 'Позвонить в банк')).toBeUndefined();

    const snapshot = await withSystem((tx) => tx<{ id: string; startAt: Date; revision: number }[]>`
      select id, start_at, revision from schedule_events where user_id = ${u} and local_date = '2026-11-04' order by id`);
    await run(u, (tx, ctx) => keepTomorrow(tx, ctx, at('2026-11-03T22:30'), '2026-11-04'));
    const later = await withSystem((tx) => tx<{ id: string; startAt: Date; revision: number }[]>`
      select id, start_at, revision from schedule_events where user_id = ${u} and local_date = '2026-11-04' order by id`);
    expect(later).toEqual(snapshot);
    const [kept] = await withSystem((tx) => tx<{ status: string }[]>`select status from day_plans where user_id = ${u} and local_date = '2026-11-04'`);
    expect(kept!.status).toBe('kept');
  });
});

describe('data rights: export and delete', () => {
  let alice: string;
  let bob: string;
  beforeAll(async () => {
    alice = await onboardUser('exp-alice', SETUP);
    bob = await onboardUser('exp-bob', SETUP);
    await run(alice, (tx, ctx) => createTask(tx, ctx, { title: 'Задача Алисы', type: 'task', category: 'personal', priority: 'normal' }));
    await run(bob, (tx, ctx) => createTask(tx, ctx, { title: 'Секрет Боба', type: 'task', category: 'personal', priority: 'normal' }));
    await addMeasurement(alice, 'weight', 70.5, '2026-11-02', '2026-11-02T08:00', 'кг');
    await addMeasurement(bob, 'weight', 90.1, '2026-11-02', '2026-11-02T08:00', 'кг');
  });

  it('export contains only own rows and no secrets', async () => {
    const b = await exportUserData(alice, SUNDAY_EVENING);
    const text = JSON.stringify(b);
    expect(b.account?.id).toBe(alice);
    expect(b.tables.tasks!.map((t) => t.title)).toEqual(['Задача Алисы']);
    expect(b.tables.scheduleEvents!.length).toBeGreaterThan(0);
    expect(b.tables.healthMeasurements!.map((m) => m.value)).toEqual([70.5]);
    expect(text).not.toContain(bob);
    expect(text).not.toContain('Секрет Боба');
    expect(text).not.toContain('password');
    expect(Object.keys(b.tables)).not.toContain('sessions');
    expect(b.notes.join(' ')).toMatch(/метаданные/);
    const csv = await healthMeasurementsCsv(alice);
    expect(csv.split('\r\n')[0]).toContain('local_date,metric_type,value');
    expect(csv).toContain('2026-11-02,weight,70.5');
    expect(csv).not.toContain('90.1');
  });

  it('delete requires the confirmation word and removes only that user (rows + files)', async () => {
    const err = await deleteAllUserData(alice, 'удалить?').catch((e) => e);
    expect((err as AppError).code).toBe('CONFIRMATION_REQUIRED');
    const rel = `${alice}/2026/test-photo.jpg`;
    await putStoredFile(rel, Buffer.from('fake'));
    await withSystem((tx) => tx`insert into media_assets (user_id, kind, storage_path, mime, size_bytes) values (${alice}, 'other', ${rel}, 'image/jpeg', 4)`);
    const file = join(resolve(process.cwd(), process.env.STORAGE_DIR ?? './data/test-media'), rel);
    expect(existsSync(file)).toBe(true);
    const bobBefore = {
      tasks: await count('select count(*) as n from tasks where user_id = $1', bob),
      events: await count('select count(*) as n from schedule_events where user_id = $1', bob),
      health: await count('select count(*) as n from health_measurements where user_id = $1', bob),
    };

    const res = await deleteAllUserData(alice, 'УДАЛИТЬ');
    expect(res.filesDeleted).toBe(1);
    expect(existsSync(file)).toBe(false);
    for (const t of ['users', 'profiles', 'tasks', 'schedule_events', 'health_measurements', 'media_assets', 'audit_events', 'sessions']) {
      const col = t === 'users' ? 'id' : 'user_id';
      expect(await count(`select count(*) as n from ${t} where ${col} = $1`, alice), t).toBe(0);
    }
    expect(await count('select count(*) as n from tasks where user_id = $1', bob)).toBe(bobBefore.tasks);
    expect(await count('select count(*) as n from schedule_events where user_id = $1', bob)).toBe(bobBefore.events);
    expect(await count('select count(*) as n from health_measurements where user_id = $1', bob)).toBe(bobBefore.health);
    expect(await count('select count(*) as n from users where id = $1', bob)).toBe(1);
  });
});

describe('optional AI commentary: aggregated facts only, failure → rules', () => {
  let u: string;
  let seen: unknown = null;
  let fail = false;
  const fake = {
    name: 'fake',
    canParse: () => true,
    weeklyInsights: async (facts: unknown) => {
      seen = facts;
      if (fail) throw new Error('boom');
      return { summary: 'Спокойная неделя', observations: [{ text: 'Завтрак отмечался', basedOn: 'meals' }], suggestions: [] };
    },
  } as unknown as AIProvider;
  beforeAll(async () => {
    u = await onboardUser('ai', SETUP);
    await run(u, (tx, ctx) => createTask(tx, ctx, { title: 'Очень личная задача', type: 'task', category: 'personal', priority: 'normal' }));
    await addMeasurement(u, 'weight', 77.7, '2026-11-03', '2026-11-03T08:00', 'кг');
    setAIProvider(fake);
  });
  afterAll(() => setAIProvider(null));

  it('is skipped without consent, used with consent, never sees titles or weight values', async () => {
    let view = await run(u, (tx, ctx) => generateWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    expect(view.ai.eligible).toBe(false);
    expect(await attachAiCommentary(u, WEEK, SUNDAY_EVENING)).toBeNull();
    await withSystem((tx) => tx`update profiles set privacy_settings = privacy_settings || '{"aiTextConsent": true}'::jsonb where user_id = ${u}`);
    const block = await attachAiCommentary(u, WEEK, SUNDAY_EVENING);
    expect(block).toMatchObject({ source: 'ai', label: 'Комментарий ИИ по фактам', summary: 'Спокойная неделя' });
    const sent = JSON.stringify(seen);
    expect(sent).not.toContain('Очень личная задача');
    expect(sent).not.toContain('77.7');
    expect(sent).toContain('weightMeasurements');
    expect(await count("select count(*) as n from external_api_usage where user_id = $1 and success", u)).toBe(1);

    fail = true;
    const fallback = await attachAiCommentary(u, WEEK, SUNDAY_EVENING);
    expect(fallback).toMatchObject({ source: 'rules' });
    view = await run(u, (tx, ctx) => getWeeklyReview(tx, ctx, SUNDAY_EVENING, WEEK));
    expect(view.review!.aiInsights?.source).toBe('rules');
    expect(view.review!.facts.summaryLines.length).toBeGreaterThan(3); // deterministic text is always there
  });
});

describe('weekly review of a brand-new account never offers weeks before it existed', () => {
  const MONDAY = at('2026-11-02T09:00');
  let u: string;
  beforeAll(async () => {
    u = await onboardUser('rev-first', MONDAY);
    // the night before the first day (a lone sleep block on Sunday) must not pull the previous week in
    await withSystem((tx) => tx`
      insert into schedule_events (user_id, local_date, start_at, end_at, kind, title, priority_class)
      values (${u}, '2026-11-01', ${at('2026-11-01T23:59').toJSDate()}, ${at('2026-11-02T08:00').toJSDate()}, 'sleep', 'Сон', 'protected')`);
  });

  it('starts at the onboarding week: default week, no «previous» arrow, first review on its Sunday', async () => {
    const first = await run(u, (tx, ctx) => accountFirstWeek(tx, ctx, MONDAY));
    expect(first).toBe(WEEK);
    // on Monday the default would be last week — but that week predates the account
    expect(await run(u, async (tx, ctx) => defaultReviewWeek(ctx, MONDAY, first))).toBe(WEEK);
    const view = await run(u, (tx, ctx) => getWeeklyReview(tx, ctx, MONDAY, WEEK));
    expect(view).toMatchObject({ firstWeek: WEEK, firstReviewDate: '2026-11-08', prevWeek: null, review: null });
    const before = await run(u, (tx, ctx) => getWeeklyReview(tx, ctx, MONDAY, '2026-10-26'));
    expect(before.weekStart < before.firstWeek).toBe(true);
    expect(before.prevWeek).toBeNull();
  });

  it('a later week still links back to the first one', async () => {
    const later = at('2026-11-10T12:00');
    const view = await run(u, (tx, ctx) => getWeeklyReview(tx, ctx, later, '2026-11-09'));
    expect(view.prevWeek).toBe(WEEK);
    expect(await run(u, async (tx, ctx) => defaultReviewWeek(ctx, later, await accountFirstWeek(tx, ctx, later)))).toBe(WEEK);
  });
});
