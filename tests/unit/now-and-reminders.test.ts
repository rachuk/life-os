import { describe, expect, it } from 'vitest';
import { computeNow, continuedByExtraWork } from '@/domain/planner/now';
import { effectiveSpec, inQuietHours, messageKey, remindersForEvent, repeatKey } from '@/domain/notifications/reminders';
import { localTimeOf } from '@/domain/time';
import { lisbon, materializeWeek, prefs, TZ } from '../helpers/plan';

const { events } = materializeWeek(prefs(), '2026-11-03', '2026-11-03', lisbon('2026-11-02T22:00'));
const tue = events.filter((e) => e.localDate === '2026-11-03' || e.kind === 'sleep');

function nowAt(time: string) {
  return computeNow({ now: lisbon(`2026-11-03T${time}`), tz: TZ, events: tue, workoutLeadMinutes: 30, eveningReviewTime: '23:15' });
}

describe('«Сейчас» card (PRD §2.1)', () => {
  it('09:05 — work is going on, next break is shown', () => {
    const s = nowAt('09:05');
    expect(s.mode).toBe('work');
    expect(s.subline).toMatch(/перекус|обед/);
    expect(s.actions.map((a) => a.label)).toContain('Добавить мысль');
    expect(s.actions.every((a) => a.variant === 'secondary')).toBe(true); // calm during work
  });

  it('13:05 — time for lunch: one-tap «Поел», +15 минут, Не могу сейчас', () => {
    const s = nowAt('13:05');
    expect(s.mode).toBe('meal');
    expect(s.headline).toBe('Пора на обед');
    expect(s.actions.map((a) => a.label)).toEqual(['Поел', '+15 минут', 'Не могу сейчас']);
    expect(s.actions[0]!.variant).toBe('primary');
  });

  it('18:00 — asks whether work is finished, offers extra work', () => {
    const s = nowAt('18:00');
    expect(s.mode).toBe('work_end');
    expect(s.actions.map((a) => a.label)).toEqual(['Закончил', 'Нужно поработать']);
  });

  it('extra work right after the main block: one question at the real end of the day', () => {
    const work = tue.find((e) => e.kind === 'work')!;
    const extra = { ...work, id: 'xw', kind: 'extra_work' as const, title: 'Дополнительная работа', startAt: work.endAt, endAt: work.endAt.plus({ hours: 2 }) };
    const withExtra = [...tue, extra];
    expect(continuedByExtraWork(work, withExtra)).toBe(true);
    // a block later in the evening (after a break > 30 min) is separate work
    expect(continuedByExtraWork(work, [{ ...extra, startAt: work.endAt.plus({ hours: 2 }), endAt: work.endAt.plus({ hours: 3 }) }])).toBe(false);
    expect(continuedByExtraWork(work, [{ ...extra, status: 'cancelled' }])).toBe(false);
    const at = (t: string) => computeNow({ now: lisbon(`2026-11-03T${t}`), tz: TZ, events: withExtra, workoutLeadMinutes: 30, eveningReviewTime: '23:15' });
    expect(at('18:30').mode).toBe('extra_work');
    expect(at('20:05').mode).toBe('extra_work_end');
    expect(at('20:05').pendingDecisions.some((e) => e.kind === 'work')).toBe(false);
  });

  it('20:35 with gym at 21:00 — get ready (after work was answered)', () => {
    const answered = tue.map((e) => (e.kind === 'work' ? { ...e, status: 'completed' as const } : e));
    const s = computeNow({ now: lisbon('2026-11-03T20:35'), tz: TZ, events: answered, workoutLeadMinutes: 30, eveningReviewTime: '23:15' });
    expect(s.mode).toBe('workout_soon');
    expect(s.actions[0]!.label).toBe('Собираюсь');
  });

  it('lists unanswered past events as pending decisions', () => {
    const s = nowAt('15:00');
    expect(s.pendingDecisions.map((e) => e.kind)).toContain('meal_lunch');
  });
});

describe('reminder rules (PRD §12)', () => {
  const gym = tue.find((e) => e.kind === 'workout')!;
  const lunch = tue.find((e) => e.kind === 'meal_lunch')!;
  const work = tue.find((e) => e.kind === 'work')!;

  it('meal → important at start; workout → lead time; work → at the end', () => {
    expect(remindersForEvent(lunch, effectiveSpec('meal_lunch', { type: 'important' }))[0]).toMatchObject({ reminderType: 'start', kind: 'important' });
    const g = remindersForEvent(gym, { type: 'important', leadMinutes: 40 })[0]!;
    expect(localTimeOf(g.scheduledAt, TZ)).toBe('20:20');
    const w = remindersForEvent(work, { type: 'important', atEnd: true })[0]!;
    expect([w.reminderType, localTimeOf(w.scheduledAt, TZ)]).toEqual(['end', '18:00']);
  });

  it('quiet hours wrap around midnight', () => {
    const q = { start: '23:30', end: '07:30' };
    expect(inQuietHours(lisbon('2026-11-03T23:45'), TZ, q)).toBe(true);
    expect(inQuietHours(lisbon('2026-11-03T07:00'), TZ, q)).toBe(true);
    expect(inQuietHours(lisbon('2026-11-03T13:00'), TZ, q)).toBe(false);
    expect(inQuietHours(lisbon('2026-11-03T13:00'), TZ, null)).toBe(false);
  });

  it('NT-02: the repeat key has no timestamp → at most one repeat per event/channel', () => {
    const a = repeatKey('u', 'e', 'start', 'telegram');
    expect(a).toBe(repeatKey('u', 'e', 'start', 'telegram'));
    expect(messageKey({ userId: 'u', eventId: 'e', reminderType: 'start', scheduledAt: lisbon('2026-11-03T13:00'), channel: 'telegram' })).not.toBe(
      messageKey({ userId: 'u', eventId: 'e', reminderType: 'start', scheduledAt: lisbon('2026-11-03T13:15'), channel: 'telegram' }),
    );
  });
});
