import { describe, expect, it } from 'vitest';
import { categorize, decideMerge, normalizeProductName } from '@/domain/shopping/normalize';

const ex = (name: string, quantity: number | null, unit: string | null, checked = false) => ({
  id: name,
  nameNormalized: normalizeProductName(name),
  quantity,
  unit,
  checked,
});

describe('shopping list rules (PRD §9.4, HEALTH-08)', () => {
  it('does not duplicate the same product without quantity', () => {
    expect(decideMerge({ name: 'Бананы', quantity: null, unit: null }, [ex('бананы', null, null)]).kind).toBe('duplicate');
    expect(decideMerge({ name: 'банана', quantity: null, unit: null }, [ex('Бананы', null, null)]).kind).toBe('duplicate');
  });

  it('merges compatible units only', () => {
    const d = decideMerge({ name: 'Молоко', quantity: 500, unit: 'мл' }, [ex('Молоко', 1, 'л')]);
    expect(d).toMatchObject({ kind: 'merge', quantity: 1.5, unit: 'л' });
    expect(decideMerge({ name: 'Молоко', quantity: 2, unit: 'шт' }, [ex('Молоко', 1, 'л')]).kind).toBe('insert');
  });

  it('never merges "молоко 2 л" with "безлактозное молоко 1 л"', () => {
    expect(decideMerge({ name: 'Безлактозное молоко', quantity: 1, unit: 'л' }, [ex('Молоко', 2, 'л')]).kind).toBe('insert');
  });

  it('a bought (checked) item can be added again', () => {
    expect(decideMerge({ name: 'Хлеб', quantity: null, unit: null }, [ex('Хлеб', null, null, true)]).kind).toBe('insert');
  });

  it('categorises common products', () => {
    expect(categorize('Бананы')).toBe('produce');
    expect(categorize('Молоко')).toBe('dairy');
    expect(categorize('Протеин')).toBe('protein');
    expect(categorize('Что-то странное')).toBe('other');
  });
});
