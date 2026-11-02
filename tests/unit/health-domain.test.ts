import { describe, expect, it } from 'vitest';
import { clampRange, denseSeries, stepsStats, trailingAverage } from '@/domain/health/series';
import { prefillSet, progressionOffer, resolveRoutine, nextRoutineKey, parseRoutines, FULL_BODY_KEY } from '@/domain/fitness/session';
import { DEFAULT_WORKOUT_PLAN } from '@/domain/fitness/catalog';
import { aggregateMenu, planMenuSync, summarizeSync } from '@/domain/shopping/fromMenu';
import { normalizeProductName } from '@/domain/shopping/normalize';

describe('health series (HEALTH-05)', () => {
  it('fills every day with an explicit null', () => {
    const s = denseSeries('2026-11-01', '2026-11-04', new Map([['2026-11-02', 0]]));
    expect(s).toEqual([
      { date: '2026-11-01', value: null },
      { date: '2026-11-02', value: 0 },
      { date: '2026-11-03', value: null },
      { date: '2026-11-04', value: null },
    ]);
    expect(stepsStats(s)).toEqual({ knownDays: 1, unknownDays: 3, averageKnown: 0 });
    expect(stepsStats(denseSeries('2026-11-01', '2026-11-02', new Map()))).toEqual({ knownDays: 0, unknownDays: 2, averageKnown: null });
  });

  it('trend is a calendar 7-day window and needs 3 points', () => {
    const s = denseSeries('2026-11-01', '2026-11-10', new Map([['2026-11-01', 53], ['2026-11-03', 53.4], ['2026-11-05', 53.2], ['2026-11-10', 54]]));
    const t = trailingAverage(s);
    expect(t[0]).toBeNull();
    expect(t[2]).toBeNull();
    expect(t[4]).toBe(53.2);
    expect(t[7]).toBeNull(); // window 02.11–08.11 holds 2 points
    expect(trailingAverage(s.slice(0, 1), [{ date: '2026-10-28', value: 52.8 }, { date: '2026-10-30', value: 53 }])[0]).toBe(52.9);
  });

  it('clamps long ranges', () => {
    expect(clampRange('2020-01-01', '2026-11-02')).toEqual({ from: '2025-11-02', to: '2026-11-02' });
    expect(clampRange('2026-11-05', '2026-11-02')).toEqual({ from: '2026-11-02', to: '2026-11-02' });
  });
});

describe('workout session helpers (PRD §10)', () => {
  const routines = DEFAULT_WORKOUT_PLAN.routines;
  const set = (setOrder: number, actualReps: number | null, weightKg: number | null, rpe: number | null = null) => ({ exerciseKey: 'squat', setOrder, actualReps, weightKg, rpe });

  it('resolves A/B/full and alternates', () => {
    expect(resolveRoutine(routines, 'A')!.name).toBe('Тренировка A');
    expect(resolveRoutine(routines, FULL_BODY_KEY)!.name).toBe('Всё тело');
    expect(resolveRoutine(routines, 'Z')).toBeNull();
    expect(nextRoutineKey(routines, null)).toBe('A');
    expect(nextRoutineKey(routines, 'A')).toBe('B');
    expect(nextRoutineKey(routines, 'B')).toBe('A');
    expect(parseRoutines('garbage')).toBe(DEFAULT_WORKOUT_PLAN.routines);
  });

  it('prefills from today, then from last time with an accepted weight', () => {
    const target = routines[0]!.exercises[0]!;
    expect(prefillSet([], [], target, null)).toEqual({ reps: 8, weightKg: null });
    expect(prefillSet([], [set(1, 10, 40), set(2, 9, 40)], target, null)).toEqual({ reps: 10, weightKg: 40 });
    expect(prefillSet([set(1, 10, 40)], [set(1, 10, 40), set(2, 9, 40)], target, 42.5)).toEqual({ reps: 10, weightKg: 40 });
    expect(prefillSet([], [set(1, 10, 40)], target, 42.5)).toEqual({ reps: 10, weightKg: 42.5 });
  });

  it('offers progression only from real sets and never after an answer', () => {
    const target = routines[0]!.exercises[0]!;
    const top = [set(1, 10, 40, 7), set(2, 10, 40, 8), set(3, 10, 40, null)];
    expect(progressionOffer('squat', 's1', top, target, false)).toMatchObject({ action: 'increase', weightKg: 42.5 });
    expect(progressionOffer('squat', 's1', top, target, true)).toBeNull();
    expect(progressionOffer('squat', 's1', top.slice(0, 2), target, false)).toBeNull();
    expect(progressionOffer('squat', 's1', [set(1, 6, 40), set(2, 8, 40), set(3, 8, 40)], target, false)).toMatchObject({ action: 'reduce' });
  });
});

describe('shopping from menu (HEALTH-08)', () => {
  const oats = { templateId: 't1', category: 'breakfast', times: 3, ingredients: [{ name: 'Молоко', quantity: 250, unit: 'мл' }, { name: 'Бананы', quantity: 1, unit: 'шт' }] };
  const omelet = { templateId: 't2', category: 'breakfast', times: 2, ingredients: [{ name: 'молоко', quantity: 50, unit: 'мл' }, { name: 'Яйца', quantity: 3, unit: 'шт' }] };
  const soup = { templateId: 't3', category: 'dinner', times: 1, ingredients: [{ name: 'Картофель', quantity: 1, unit: 'кг' }] };

  it('aggregates compatible units and routes dinner to the household basket', () => {
    const lines = aggregateMenu([oats, omelet, soup, { ...oats, templateId: 't4', times: 0 }]);
    expect(lines.find((l) => l.name === 'Молоко')).toMatchObject({ quantity: 850, unit: 'мл', listType: 'personal', templateIds: ['t1', 't2'] });
    expect(lines.find((l) => l.name === 'Картофель')).toMatchObject({ listType: 'household', quantity: 1, unit: 'кг' });
    expect(lines).toHaveLength(4);
  });

  it('is idempotent and never touches manual lines', () => {
    const lines = aggregateMenu([oats]);
    const existing = [
      { id: 'm', listType: 'personal' as const, name: 'Молоко', nameNormalized: normalizeProductName('Молоко'), quantity: 1, unit: 'л', checked: false, source: 'manual' },
      { id: 'g', listType: 'personal' as const, name: 'Бананы', nameNormalized: normalizeProductName('Бананы'), quantity: 3, unit: 'шт', checked: false, source: 'meal_template' },
      { id: 'old', listType: 'personal' as const, name: 'Гранола', nameNormalized: normalizeProductName('Гранола'), quantity: 50, unit: 'г', checked: false, source: 'meal_template' },
    ];
    const actions = planMenuSync(lines, existing);
    expect(actions.map((a) => a.kind).sort()).toEqual(['remove', 'skip_manual', 'unchanged']);
    expect(summarizeSync(actions)).toMatchObject({ inserted: 0, skipped: 1, removed: 1, unchanged: 1 });
  });
});
