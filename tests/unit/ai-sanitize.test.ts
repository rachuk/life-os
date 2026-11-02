import { describe, expect, it } from 'vitest';
import { _test } from '@/server/ai/provider';

describe('AI output normalisation', () => {
  it('drops invented enum values instead of rejecting the whole answer', () => {
    const r = _test.cleanActions({
      language: 'ru',
      actions: [
        { type: 'create_task', title: 'Написать брокеру', taskType: 'reminder', category: 'tasks', dateLocal: '2026-11-03', timeLocal: null, sourceText: 'x', needsConfirmation: false, reason: null },
        { type: 'add_shopping_item', title: 'молоко', quantity: 1, unit: null, listType: 'groceries', sourceText: 'купи молоко', needsConfirmation: false },
        { type: 'log_meal', slot: 'brunch', description: 'x', sourceText: 'x', needsConfirmation: true },
      ],
    }) as { actions: { type: string; category?: string; listType?: string }[] };
    expect(r.actions.map((a) => a.type)).toEqual(['create_task', 'add_shopping_item']); // invalid meal slot → that action only is dropped
    expect(r.actions[0]!.category).toBe('personal');
    expect(r.actions[1]!.listType).toBe('personal');
  });

  it('still refuses when nothing valid is left', () => {
    expect(() => _test.cleanActions({ language: 'ru', actions: [{ type: 'transfer_money', amount: 100 }] })).toThrow();
  });
});
