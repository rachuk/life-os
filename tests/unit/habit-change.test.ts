import { describe, expect, it } from 'vitest';
import {
  baselineStatus,
  dayStatus,
  detectHabitPatterns,
  savings,
  scheduledLimit,
  suggestedStartLimit,
  summarizeDays,
  type HabitEvent,
} from '@/domain/habits/change';

const use = (date: string, hour: number, reason: string | null = null, extra: Partial<HabitEvent> = {}): HabitEvent => ({
  kind: 'use',
  localDate: date,
  localHour: hour,
  quantity: 1,
  reason,
  ...extra,
});

describe('habit change: day summaries', () => {
  it('no data stays null, a day total overrides the per-use sum', () => {
    const days = summarizeDays(
      [use('2026-11-02', 9), use('2026-11-02', 13), { kind: 'day_total', localDate: '2026-11-03', localHour: 23, quantity: 8, reason: null }, use('2026-11-03', 10)],
      '2026-11-02',
      '2026-11-04',
    );
    expect(days.map((d) => d.total)).toEqual([2, 8, null]);
    expect(days[1]!.fromDayTotal).toBe(true);
  });
});

describe('baseline and gradual limit', () => {
  it('needs the full window and at least 3 days with data', () => {
    const events = ['2026-11-02', '2026-11-03', '2026-11-04'].flatMap((d) => Array.from({ length: 12 }, (_, i) => use(d, 8 + i)));
    const days = summarizeDays(events, '2026-11-02', '2026-11-08');
    expect(baselineStatus(days, '2026-11-02', '2026-11-05', 7).ready).toBe(false);
    const done = baselineStatus(days, '2026-11-02', '2026-11-09', 7);
    expect(done.ready).toBe(true);
    expect(done.perDay).toBe(12);
  });

  it('starts one step below the baseline and goes down weekly, never below zero', () => {
    expect(suggestedStartLimit(12, 1)).toBe(11);
    expect(suggestedStartLimit(11.4, 2)).toBe(10);
    expect(scheduledLimit(11, '2026-11-09', '2026-11-15', 1)).toBe(11);
    expect(scheduledLimit(11, '2026-11-09', '2026-11-16', 1)).toBe(10);
    expect(scheduledLimit(2, '2026-11-09', '2026-12-31', 1)).toBe(0);
  });

  it('a slip is just "over" for that day — unknown is not a failure', () => {
    expect(dayStatus(12, 10)).toBe('over');
    expect(dayStatus(null, 10)).toBe('unknown');
    expect(dayStatus(9, 10)).toBe('within');
  });
});

describe('savings and patterns', () => {
  it('counts only known days against the baseline', () => {
    const days = summarizeDays([use('2026-11-10', 9), use('2026-11-10', 10)], '2026-11-10', '2026-11-12');
    const s = savings(days, 12, 35);
    expect(s).toEqual({ units: 10, cents: 350, daysCounted: 1 });
    expect(savings(days, null, 35).units).toBe(0);
  });

  it('finds top reason, time of day and the extra-work link without causal claims', () => {
    const events: HabitEvent[] = [
      ...['2026-11-02', '2026-11-03'].flatMap((d) => Array.from({ length: 10 }, (_, i) => use(d, 19 + (i % 3), i % 2 ? 'Рабочий стресс' : 'После кофе', { duringExtraWork: true }))),
      ...['2026-11-04', '2026-11-05'].flatMap((d) => Array.from({ length: 5 }, () => use(d, 10, 'После кофе', { duringWork: true }))),
    ];
    const days = summarizeDays(events, '2026-11-02', '2026-11-05');
    const p = detectHabitPatterns(events, days, new Set(['2026-11-02', '2026-11-03']), 'стиков');
    expect(p.map((x) => x.key)).toEqual(expect.arrayContaining(['top_reason', 'extra_work']));
    expect(p.find((x) => x.key === 'extra_work')!.text).toMatch(/В дни с переработкой в среднем 10 против 5/);
    for (const x of p) expect(x.text).not.toMatch(/из-за/);
  });
});
