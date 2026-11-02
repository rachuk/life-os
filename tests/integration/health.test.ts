import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withUser } from '@/server/db';
import { AppError } from '@/server/http';
import { addMeasurement, daySummary, healthSummary } from '@/server/services/health';
import { habitsWeek, listHabits, recordCheckin } from '@/server/services/habits';
import { listMealTemplates, logMeal, planMeal, undoMealLog } from '@/server/services/meals';
import { transitionEvent, weekProgress } from '@/server/services/planning';
import { loadContext, type UserContext } from '@/server/services/profile';
import { addFromMealTemplates, addShoppingText, setItemChecked, updateItem, weekShopping } from '@/server/services/shopping';
import { decideProgression, finishSession, quickLog, startSession, upsertSet, workoutOverview } from '@/server/services/workouts';
import type { Tx } from '@/server/db';
import { onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const at = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toUTC();
const SUNDAY = at('2026-11-01T20:00');
const MONDAY_0830 = at('2026-11-02T08:30');
const MONDAY_1400 = at('2026-11-02T14:00');
const MONDAY_2100 = at('2026-11-02T21:00');
const TUESDAY_2100 = at('2026-11-03T21:00');
const TUESDAY_2200 = at('2026-11-03T22:00');
const WEDNESDAY_1000 = at('2026-11-04T10:00');
const SATURDAY_1300 = at('2026-11-07T13:00');
const SUNDAY_1800 = at('2026-11-08T18:00');

let userId: string;

beforeAll(async () => {
  userId = await onboardUser('health', SUNDAY);
});

function as<T>(fn: (tx: Tx, ctx: UserContext) => Promise<T>): Promise<T> {
  return withUser(userId, async (tx) => fn(tx, await loadContext(tx, userId)));
}

async function eventOf(kind: string, date: string) {
  const [e] = await withSystem((tx) => tx<{ id: string; status: string; localDate: string; revision: number }[]>`
    select id, status, local_date, revision from schedule_events where user_id = ${userId} and kind = ${kind} and local_date = ${date}`);
  return e!;
}

describe('HEALTH-01: manual weight with date and source', () => {
  it('saves 53.2 kg for the local date with its source', async () => {
    const m = await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_0830, { metricType: 'weight', value: 53.2, sourceType: 'manual', replace: false }));
    expect(m.value).toBe(53.2);
    expect(m.unit).toBe('кг');
    expect(m.localDate).toBe('2026-11-02');
    expect(m.sourceType).toBe('manual');
    expect(m.userConfirmedAt).toBeInstanceOf(Date);
  });

  it('a second value on the same date is a 409 «Заменить?» and then replaces, never adds', async () => {
    const err = await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'weight', value: 53.4, sourceType: 'manual', replace: false })).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(409);
    expect((err as AppError).code).toBe('DUPLICATE_FOR_DATE');
    expect(((err as AppError).details as { existing: { value: number } }).existing.value).toBe(53.2);

    const m = await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'weight', value: 53.4, sourceType: 'manual', replace: true }));
    expect(m.value).toBe(53.4);
    const rows = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from health_measurements where user_id = ${userId} and metric_type = 'weight' and local_date = '2026-11-02'`);
    expect(rows[0]!.n).toBe(1);
  });

  it('the value is not shown for another date', async () => {
    const [yesterday, today, tomorrow] = await as(async (tx, ctx) => [
      await daySummary(tx, ctx.userId, '2026-11-01'),
      await daySummary(tx, ctx.userId, '2026-11-02'),
      await daySummary(tx, ctx.userId, '2026-11-03'),
    ]);
    expect(yesterday!.weight).toBeNull();
    expect(today!.weight).toBe(53.4);
    expect(tomorrow!.weight).toBeNull();
    const s = await as((tx, ctx) => healthSummary(tx, ctx.userId, '2026-10-30', '2026-11-03'));
    expect(s.days.map((d) => d.weight)).toEqual([null, null, null, 53.4, null]);
  });

  it('rejects a future date', async () => {
    const err = await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'weight', value: 53, localDate: '2026-11-05', sourceType: 'manual', replace: false })).catch((e) => e);
    expect((err as AppError).code).toBe('FUTURE_DATE');
  });
});

describe('HEALTH-05: «нет данных» differs from 0', () => {
  it('keeps explicit nulls next to a real zero and averages known days only', async () => {
    await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'steps', value: 0, localDate: '2026-10-30', sourceType: 'manual', replace: false }));
    await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'steps', value: 6500, localDate: '2026-11-01', sourceType: 'screenshot', replace: false }));
    const s = await as((tx, ctx) => healthSummary(tx, ctx.userId, '2026-10-29', '2026-11-02'));
    expect(s.days.map((d) => d.steps)).toEqual([null, 0, null, 6500, null]);
    expect(s.steps).toEqual({ knownDays: 2, unknownDays: 3, averageKnown: 3250 });
    expect(s.days.every((d) => d.waterMl === null)).toBe(true);
  });

  it('shows the 7-day weight average only with enough points in the window', async () => {
    await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'weight', value: 53.0, localDate: '2026-10-28', sourceType: 'manual', replace: false }));
    await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'weight', value: 53.2, localDate: '2026-10-30', sourceType: 'manual', replace: false }));
    const s = await as((tx, ctx) => healthSummary(tx, ctx.userId, '2026-10-30', '2026-11-02'));
    const byDate = Object.fromEntries(s.days.map((d) => [d.date, d.weightAvg7]));
    expect(byDate['2026-10-30']).toBeNull(); // only 2 points in 24.10–30.10
    expect(byDate['2026-11-02']).toBe(53.2); // (53.0 + 53.2 + 53.4) / 3
    expect(s.weight.latestTrend).toBe(53.2);
  });

  it('water is additive and needs no replace', async () => {
    await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'water_ml', value: 250, sourceType: 'manual', replace: false }));
    await as((tx, ctx) => addMeasurement(tx, ctx, MONDAY_1400, { metricType: 'water_ml', value: 500, sourceType: 'manual', replace: false }));
    const d = await as((tx, ctx) => daySummary(tx, ctx.userId, '2026-11-02'));
    expect(d.waterMl).toBe(750);
  });
});

describe('daily rule «Не работаю в кровати»', () => {
  it('records done / exception with reason, never for a future day', async () => {
    const habit = (await as((tx, ctx) => listHabits(tx, ctx.userId))).find((h) => h.key === 'no_work_in_bed')!;
    expect(habit.type).toBe('daily_rule');
    await as((tx, ctx) => recordCheckin(tx, ctx, MONDAY_2100, { habitId: habit.id, localDate: '2026-11-01', status: 'done' }));
    await as((tx, ctx) => recordCheckin(tx, ctx, MONDAY_2100, { habitId: habit.id, localDate: '2026-11-02', status: 'exception', reason: ' срочный созвон ' }));
    const err = await as((tx, ctx) => recordCheckin(tx, ctx, MONDAY_2100, { habitId: habit.id, localDate: '2026-11-03', status: 'done' })).catch((e) => e);
    expect((err as AppError).code).toBe('FUTURE_DATE');
    const w = await as((tx, ctx) => habitsWeek(tx, ctx.userId, '2026-11-02'));
    const mine = w.checkins.filter((c) => c.habitId === habit.id);
    expect(mine).toHaveLength(1); // Sunday 01.11 belongs to the previous week
    expect(mine[0]).toMatchObject({ localDate: '2026-11-02', status: 'exception', reason: 'срочный созвон' });
  });
});

describe('HEALTH-08: shopping without duplicates', () => {
  it('merges compatible units, keeps different products apart, reports duplicates', async () => {
    const add = (text: string) => as((tx, ctx) => addShoppingText(tx, ctx, MONDAY_1400, { text, listType: 'personal' }));
    expect((await add('молоко 1 л')).outcome).toBe('inserted');
    const merged = await add('Молоко 500 мл');
    expect(merged.outcome).toBe('merged');
    expect(merged.item).toMatchObject({ quantity: 1.5, unit: 'л' });
    expect((await add('безлактозное молоко 1 л')).outcome).toBe('inserted');
    expect((await add('Бананы')).outcome).toBe('inserted');
    const dup = await add('бананы');
    expect(dup.outcome).toBe('duplicate');
    expect(dup.message).toMatch(/Уже есть/);
    const week = await as((tx, ctx) => weekShopping(tx, ctx.userId, '2026-11-04'));
    expect(week.weekStart).toBe('2026-11-02');
    const personal = week.lists.find((l) => l.listType === 'personal')!;
    expect(personal.items).toHaveLength(3);
    expect(week.lists.find((l) => l.listType === 'household')!.items).toHaveLength(0);
    expect(personal.text).toContain('Молоко — 1.5 л');
  });

  it('«Собрать из меню» twice does not duplicate or double, keeps manual and bought lines', async () => {
    const templates = await as((tx, ctx) => listMealTemplates(tx, ctx.userId));
    const oats = templates.find((t) => t.title.startsWith('Овсянка'))!;
    const omelet = templates.find((t) => t.title.startsWith('Омлет'))!;
    const week = '2026-11-09';
    await as((tx, ctx) => addShoppingText(tx, ctx, MONDAY_1400, { text: 'Молоко 1 л', listType: 'personal', weekStart: week }));
    const picks = [
      { templateId: oats.id, times: 3 },
      { templateId: omelet.id, times: 2 },
    ];
    const first = await as((tx, ctx) => addFromMealTemplates(tx, ctx, MONDAY_1400, week, picks));
    expect(first.skipped).toBe(1); // milk was added by hand → not duplicated
    expect(first.messages[0]).toMatch(/Молоко/);
    const afterFirst = (await as((tx, ctx) => weekShopping(tx, ctx.userId, week))).lists.find((l) => l.listType === 'personal')!.items;
    const eggs = afterFirst.find((i) => i.name === 'Яйца')!;
    expect(eggs).toMatchObject({ quantity: 6, unit: 'шт', source: 'meal_template' });
    expect(eggs.notes).toMatch(/Проверь дома/);
    expect(afterFirst.filter((i) => i.nameNormalized === afterFirst.find((x) => x.name === 'Молоко')!.nameNormalized)).toHaveLength(1);

    const second = await as((tx, ctx) => addFromMealTemplates(tx, ctx, MONDAY_1400, week, picks));
    expect(second.inserted).toBe(0);
    expect(second.updated).toBe(0);
    const afterSecond = (await as((tx, ctx) => weekShopping(tx, ctx.userId, week))).lists.find((l) => l.listType === 'personal')!.items;
    expect(afterSecond).toHaveLength(afterFirst.length);
    expect(afterSecond.find((i) => i.name === 'Яйца')!.quantity).toBe(6);

    // fewer omelets → the generated line is updated, not added to
    const third = await as((tx, ctx) => addFromMealTemplates(tx, ctx, MONDAY_1400, week, [picks[0]!, { templateId: omelet.id, times: 1 }]));
    expect(third.updated).toBeGreaterThan(0);
    const eggs3 = (await as((tx, ctx) => weekShopping(tx, ctx.userId, week))).lists[0]!.items.find((i) => i.name === 'Яйца')!;
    expect(eggs3.quantity).toBe(3);

    // bought line is not re-added; hand-edited line becomes the user's own
    await as((tx, ctx) => setItemChecked(tx, ctx.userId, eggs3.id, true));
    const oatsLine = afterSecond.find((i) => i.name === 'Овсяные хлопья')!;
    await as((tx, ctx) => updateItem(tx, ctx.userId, oatsLine.id, { quantity: 500, unit: 'г' }));
    const fourth = await as((tx, ctx) => addFromMealTemplates(tx, ctx, MONDAY_1400, week, picks));
    expect(fourth.inserted).toBe(0);
    const items4 = (await as((tx, ctx) => weekShopping(tx, ctx.userId, week))).lists[0]!.items;
    expect(items4.filter((i) => i.name === 'Яйца')).toHaveLength(1);
    expect(items4.find((i) => i.id === oatsLine.id)!.quantity).toBe(500);
    expect(fourth.messages.some((m) => /куплен/.test(m))).toBe(true);
  });
});

describe('workouts count toward the weekly target', () => {
  it('a session linked to the planned workout drives planned → started → completed', async () => {
    const before = await as((tx, ctx) => weekProgress(tx, ctx, '2026-11-02'));
    expect(before.workouts).toMatchObject({ target: 2, planned: 2, completed: 0 });
    const tue = await eventOf('workout', '2026-11-03');
    const { session } = await as((tx, ctx) => startSession(tx, ctx, TUESDAY_2100, { routineKey: 'A', eventId: tue.id }));
    expect((await eventOf('workout', '2026-11-03')).status).toBe('started');

    // a second, different start is refused while one runs
    const err = await as((tx, ctx) => startSession(tx, ctx, TUESDAY_2100, { routineKey: 'B' })).catch((e) => e);
    expect((err as AppError).code).toBe('SESSION_ACTIVE');

    for (let i = 0; i < 3; i++) {
      await as((tx, ctx) => upsertSet(tx, ctx, TUESDAY_2100, session.id, { exerciseKey: 'squat', actualReps: 10, weightKg: 40, rpe: 7 }));
    }
    const mid = await as((tx, ctx) => weekProgress(tx, ctx, '2026-11-02'));
    expect(mid.workouts.completed).toBe(0); // started ≠ completed

    const fin = await as((tx, ctx) => finishSession(tx, ctx, TUESDAY_2200, session.id, { perceivedEffort: 7, notes: 'норм' }));
    expect(fin.session).toMatchObject({ status: 'completed', durationMinutes: 60, perceivedEffort: 7 });
    expect((await eventOf('workout', '2026-11-03')).status).toBe('completed');
    const again = await as((tx, ctx) => finishSession(tx, ctx, TUESDAY_2200, session.id, {}));
    expect(again.changed).toBe(false);
    expect((await as((tx, ctx) => weekProgress(tx, ctx, '2026-11-02'))).workouts.completed).toBe(1);
  });

  it('suggests progression from logged sets only, and remembers «Принять»', async () => {
    const o = await as((tx, ctx) => workoutOverview(tx, ctx, WEDNESDAY_1000));
    const squat = o.exercises.squat!;
    expect(squat.previous!.sets).toHaveLength(3);
    expect(squat.prefill).toEqual({ reps: 10, weightKg: 40 });
    expect(squat.offer).toMatchObject({ action: 'increase', weightKg: 42.5 });
    expect(o.exercises.bench_press!.offer).toBeNull(); // no sets logged → no suggestion
    expect(o.suggestedRoutineKey).toBe('B');

    await as((tx, ctx) => decideProgression(tx, ctx.userId, { exerciseKey: 'squat', basedOnSessionId: squat.offer!.basedOnSessionId, decision: 'accepted', weightKg: 42.5 }));
    const o2 = await as((tx, ctx) => workoutOverview(tx, ctx, WEDNESDAY_1000));
    expect(o2.exercises.squat!.offer).toBeNull();
    expect(o2.exercises.squat!.prefill).toEqual({ reps: 10, weightKg: 42.5 });
  });

  it('PL-10 complement: moving the planned workout within the week keeps the target; quick log counts', async () => {
    const thu = await eventOf('workout', '2026-11-05');
    const moved = await as((tx, ctx) =>
      transitionEvent(tx, ctx, WEDNESDAY_1000, thu.id, { action: 'reschedule', toDate: '2026-11-07', toTime: '11:00', reason: 'Изменились планы' }),
    );
    expect(moved.event.localDate).toBe('2026-11-07');
    const p = await as((tx, ctx) => weekProgress(tx, ctx, '2026-11-02'));
    expect(p.workouts).toMatchObject({ target: 2, planned: 2, completed: 1 });

    const q = await as((tx, ctx) => quickLog(tx, ctx, SATURDAY_1300, { durationMinutes: 45, eventId: thu.id }));
    expect(q.session).toMatchObject({ status: 'completed', durationMinutes: 45, scheduleEventId: thu.id, localDate: '2026-11-07' });
    expect((await eventOf('workout', '2026-11-07')).status).toBe('completed');
    const repeat = await as((tx, ctx) => quickLog(tx, ctx, SATURDAY_1300, { durationMinutes: 45, eventId: thu.id }));
    expect(repeat.changed).toBe(false);
    expect((await as((tx, ctx) => weekProgress(tx, ctx, '2026-11-02'))).workouts.completed).toBe(2);

    // an extra workout without a planned event still counts
    await as((tx, ctx) => quickLog(tx, ctx, SUNDAY_1800, { durationMinutes: 30 }));
    expect((await as((tx, ctx) => weekProgress(tx, ctx, '2026-11-02'))).workouts.completed).toBe(3);
  });
});

describe('HEALTH-03: a meal is eaten only after an explicit consumption answer', () => {
  it('planning a dish does not complete the event; the answer does', async () => {
    const lunch = await eventOf('meal_lunch', '2026-11-02');
    await as((tx, ctx) => planMeal(tx, ctx.userId, { localDate: '2026-11-02', slot: 'lunch', description: 'суп соседки' }));
    expect((await eventOf('meal_lunch', '2026-11-02')).status).toBe(lunch.status);
    expect(lunch.status).not.toBe('completed');

    await as((tx, ctx) => logMeal(tx, ctx, MONDAY_1400, { eventId: lunch.id, consumptionStatus: 'part', description: 'половина', drinks: [] }));
    expect((await eventOf('meal_lunch', '2026-11-02')).status).toBe('completed');

    const dinner = await eventOf('meal_dinner', '2026-11-02');
    await as((tx, ctx) => logMeal(tx, ctx, MONDAY_2100, { eventId: dinner.id, consumptionStatus: 'not_eaten', reason: 'Нет времени', drinks: [] }));
    expect((await eventOf('meal_dinner', '2026-11-02')).status).toBe('skipped');
    const logs = await withSystem((tx) => tx<{ consumptionStatus: string }[]>`
      select consumption_status from meal_logs where user_id = ${userId} and local_date = '2026-11-02' order by eaten_at`);
    expect(logs.map((l) => l.consumptionStatus)).toEqual(['part', 'not_eaten']);
  });

  it('«Отменить» after a one-tap «Съел» removes the log and reopens the event; a repeat is 404', async () => {
    const TUESDAY_0900 = at('2026-11-03T09:00');
    const breakfast = await eventOf('meal_breakfast', '2026-11-03');
    expect(breakfast.status).toBe('planned');
    const log = await as((tx, ctx) => logMeal(tx, ctx, TUESDAY_0900, { eventId: breakfast.id, consumptionStatus: 'all', drinks: [] }));
    expect((await eventOf('meal_breakfast', '2026-11-03')).status).toBe('completed');

    const r = await as((tx, ctx) => undoMealLog(tx, ctx, TUESDAY_0900, log.id));
    expect(r.reopened).toBe(true);
    expect((await eventOf('meal_breakfast', '2026-11-03')).status).toBe('planned');
    const left = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from meal_logs where id = ${log.id}`);
    expect(left[0]!.n).toBe(0);

    const again = await as((tx, ctx) => undoMealLog(tx, ctx, TUESDAY_0900, log.id)).catch((e) => e);
    expect(again).toBeInstanceOf(AppError);
    expect((again as AppError).status).toBe(404);

    // «Не ел» is undone the same way: skipped → planned
    const skip = await as((tx, ctx) => logMeal(tx, ctx, TUESDAY_0900, { eventId: breakfast.id, consumptionStatus: 'not_eaten', drinks: [] }));
    expect((await eventOf('meal_breakfast', '2026-11-03')).status).toBe('skipped');
    await as((tx, ctx) => undoMealLog(tx, ctx, TUESDAY_0900, skip.id));
    expect((await eventOf('meal_breakfast', '2026-11-03')).status).toBe('planned');
  });

  it('undo leaves an event alone when it was settled by something else', async () => {
    const TUESDAY_1400 = at('2026-11-03T14:00');
    const lunch = await eventOf('meal_lunch', '2026-11-03');
    await as((tx, ctx) => transitionEvent(tx, ctx, TUESDAY_1400, lunch.id, { action: 'complete' }));
    const log = await as((tx, ctx) => logMeal(tx, ctx, TUESDAY_1400, { eventId: lunch.id, consumptionStatus: 'part', drinks: [] }));
    const r = await as((tx, ctx) => undoMealLog(tx, ctx, TUESDAY_1400, log.id));
    expect(r.reopened).toBe(false);
    expect((await eventOf('meal_lunch', '2026-11-03')).status).toBe('completed');

    // with two answers for one event, removing one keeps the event settled
    const dinner = await eventOf('meal_dinner', '2026-11-03');
    const first = await as((tx, ctx) => logMeal(tx, ctx, TUESDAY_2100, { eventId: dinner.id, consumptionStatus: 'all', drinks: [] }));
    await as((tx, ctx) => logMeal(tx, ctx, TUESDAY_2100, { eventId: dinner.id, consumptionStatus: 'replaced', drinks: [] }));
    expect((await as((tx, ctx) => undoMealLog(tx, ctx, TUESDAY_2100, first.id))).reopened).toBe(false);
    expect((await eventOf('meal_dinner', '2026-11-03')).status).toBe('completed');
  });

  it('clearing the plan restores the «домашнее блюдо» default', async () => {
    await as((tx, ctx) => planMeal(tx, ctx.userId, { localDate: '2026-11-02', slot: 'lunch', description: '' }));
    const rows = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from meal_plan_entries where user_id = ${userId} and local_date = '2026-11-02' and meal_slot = 'lunch'`);
    expect(rows[0]!.n).toBe(0);
  });
});
