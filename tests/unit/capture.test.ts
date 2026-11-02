import { describe, expect, it } from 'vitest';
import { parseCapture } from '@/domain/capture/parser';
import { resolveDateTime } from '@/domain/capture/dates';
import { lisbon, TZ } from '../helpers/plan';

const now = lisbon('2026-11-01T20:00'); // Sunday evening
const ctx = { now, tz: TZ, gymWindow: { earliest: '18:30', latest: '22:30' } };

describe('relative dates (ru/uk/en) are resolved from the real message time', () => {
  it('resolves tomorrow / weekdays / explicit dates', () => {
    expect(resolveDateTime('завтра', now, TZ).date).toBe('2026-11-02');
    expect(resolveDateTime('післязавтра', now, TZ).date).toBe('2026-11-03');
    expect(resolveDateTime('в четверг', now, TZ).date).toBe('2026-11-05');
    expect(resolveDateTime('у п’ятницю', now, TZ).date).toBe('2026-11-06');
    expect(resolveDateTime('on friday', now, TZ).date).toBe('2026-11-06');
    expect(resolveDateTime('5 ноября', now, TZ).date).toBe('2026-11-05');
    expect(resolveDateTime('12.11', now, TZ).date).toBe('2026-11-12');
    expect(resolveDateTime('вчера', now, TZ).date).toBe('2026-10-31');
  });

  it('does not mistake a date like 2.11 for a time', () => {
    const r = resolveDateTime('2.11 в 18:30', now, TZ);
    expect(r.date).toBe('2026-11-02');
    expect(r.time).toBe('18:30');
  });

  it('TASK-03: ambiguous phrases require confirmation', () => {
    const r = resolveDateTime('в следующий четверг', now, TZ);
    expect(r.ambiguous).toBe(true);
    expect(r.date).toBe('2026-11-05');
    expect(resolveDateTime('в понедельник вечером', now, TZ).ambiguous).toBe(true);
    expect(resolveDateTime('в 9', now, TZ).ambiguous).toBe(true);
  });
});

describe('capture parser', () => {
  it('TASK-01: "напомни завтра написать брокеру, купить бананы" → task + shopping item', () => {
    const r = parseCapture('напомни завтра написать брокеру, купить бананы', ctx);
    expect(r.actions.map((a) => a.type)).toEqual(['create_task', 'add_shopping_item']);
    const task = r.actions[0]!;
    if (task.type !== 'create_task') throw new Error('expected task');
    expect(task.dateLocal).toBe('2026-11-02');
    expect(task.title).toMatch(/брокеру/i);
    expect(task.category).toBe('finance');
    const item = r.actions[1]!;
    expect(item.type === 'add_shopping_item' && item.title).toBe('Бананы');
  });

  it('TASK-02: an item without a date gets no invented deadline', () => {
    const r = parseCapture('записаться на чистку зубов', ctx);
    const a = r.actions[0]!;
    expect(a.type).toBe('create_task');
    if (a.type === 'create_task') {
      expect(a.dateLocal).toBeNull();
      expect(a.category).toBe('health');
    }
  });

  it('PRD §6.5: one voice message → separate proposals with explicit dates', () => {
    const r = parseCapture(
      'Завтра напомни брокеру написать, закажи молоко и бананы в список, в четверг хочу в зал в девять, ещё подумать про страховку',
      ctx,
    );
    const types = r.actions.map((a) => a.type);
    expect(types).toEqual(['create_task', 'add_shopping_item', 'add_shopping_item', 'schedule_workout', 'idea']);
    const gym = r.actions[3]!;
    if (gym.type !== 'schedule_workout') throw new Error('expected workout');
    expect(gym.dateLocal).toBe('2026-11-05');
    expect(gym.timeLocal).toBe('21:00');
    expect(gym.needsConfirmation).toBe(true);
  });

  it('understands Ukrainian and English', () => {
    const uk = parseCapture('треба записатися до стоматолога в понеділок о 10:30', ctx).actions[0]!;
    expect(uk.type === 'create_task' && [uk.dateLocal, uk.timeLocal, uk.category]).toEqual(['2026-11-02', '10:30', 'health']);
    const en = parseCapture('remind me tomorrow at 5 to call the bank and buy eggs', ctx).actions;
    expect(en.map((a) => a.type)).toEqual(['create_task', 'add_shopping_item']);
    expect(en[0]!.needsConfirmation).toBe(true);
  });

  it('parses measurements and extra work', () => {
    const w = parseCapture('вес 53,2', ctx).actions;
    expect(w).toHaveLength(1);
    expect(w[0]!.type === 'log_weight' && w[0]!.value).toBe(53.2);
    const s = parseCapture('прошёл 7 500 шагов вчера', ctx).actions[0]!;
    expect(s.type === 'log_steps' && [s.value, s.dateLocal]).toEqual([7500, '2026-10-31']);
    const x = parseCapture('нужно поработать 2 часа', ctx).actions[0]!;
    expect(x.type === 'extra_work' && x.durationMinutes).toBe(120);
    expect(x.needsConfirmation).toBe(true);
  });

  it('keeps quantities and does not merge different products', () => {
    const r = parseCapture('купить молоко 2 л, безлактозное молоко 1 л, хлеб', ctx).actions;
    expect(r.map((a) => (a.type === 'add_shopping_item' ? [a.title, a.quantity, a.unit] : null))).toEqual([
      ['Молоко', 2, 'л'],
      ['Безлактозное молоко', 1, 'л'],
      ['Хлеб', null, null],
    ]);
  });

  it('a meal log always needs explicit confirmation (HEALTH-03)', () => {
    const a = parseCapture('пообедал супом', ctx).actions[0]!;
    expect(a.type).toBe('log_meal');
    expect(a.needsConfirmation).toBe(true);
  });

  it('turns "sent … waiting for reply" into a waiting item with follow-up', () => {
    const a = parseCapture('отправил письмо брокеру, жду ответа от брокера', ctx).actions;
    expect(a).toHaveLength(1);
    expect(a[0]!.type).toBe('create_waiting');
    if (a[0]!.type === 'create_waiting') expect(a[0]!.followUpDate).toBe('2026-11-04');
  });

  it('unknown text becomes an inbox note, not a fake task', () => {
    const a = parseCapture('просто мысль без действия', ctx).actions[0]!;
    expect(a.type).toBe('note');
  });
});
