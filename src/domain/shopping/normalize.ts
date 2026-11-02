/**
 * Shopping list rules (PRD §9.3–9.4):
 *  - the same product is not added twice;
 *  - quantities merge only when units are compatible (л/мл, кг/г, шт);
 *  - different products ("молоко" vs "безлактозное молоко") never merge.
 */

const STOP = new Set(['для', 'и', 'с', 'на', 'в', 'the', 'of']);

function stemWord(w: string): string {
  if (w.length <= 4) return w;
  return w.replace(/(ами|ями|ов|ев|ей|ой|ий|ый|ая|яя|ое|ее|ые|ие|ам|ям|ах|ях|а|я|ы|и|у|ю|е|о|s)$/u, '');
}

export function normalizeProductName(name: string): string {
  return name
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/u)
    .filter((w) => w && !STOP.has(w))
    .map(stemWord)
    .join(' ')
    .trim();
}

const UNIT_GROUPS: Record<string, { base: string; factor: number }> = {
  л: { base: 'мл', factor: 1000 },
  мл: { base: 'мл', factor: 1 },
  кг: { base: 'г', factor: 1000 },
  г: { base: 'г', factor: 1 },
  шт: { base: 'шт', factor: 1 },
  уп: { base: 'уп', factor: 1 },
  бут: { base: 'бут', factor: 1 },
};

export function compatibleUnits(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  return UNIT_GROUPS[a]?.base !== undefined && UNIT_GROUPS[a]?.base === UNIT_GROUPS[b]?.base;
}

/** Sum two quantities expressed in compatible units, keeping the larger display unit when possible. */
export function addQuantities(q1: number, u1: string, q2: number, u2: string): { quantity: number; unit: string } {
  const g1 = UNIT_GROUPS[u1]!;
  const g2 = UNIT_GROUPS[u2]!;
  const total = q1 * g1.factor + q2 * g2.factor;
  const big = Object.entries(UNIT_GROUPS).find(([, g]) => g.base === g1.base && g.factor > 1);
  if (big && total >= big[1].factor && total % (big[1].factor / 10) === 0) {
    return { quantity: Math.round((total / big[1].factor) * 1000) / 1000, unit: big[0] };
  }
  return { quantity: Math.round(total * 1000) / 1000, unit: g1.base };
}

export interface ExistingItem {
  id: string;
  nameNormalized: string;
  quantity: number | null;
  unit: string | null;
  checked: boolean;
}

export type MergeDecision =
  | { kind: 'insert' }
  | { kind: 'duplicate'; existingId: string; message: string }
  | { kind: 'merge'; existingId: string; quantity: number; unit: string; message: string };

export function decideMerge(
  item: { name: string; quantity: number | null; unit: string | null },
  existing: ExistingItem[],
): MergeDecision {
  const key = normalizeProductName(item.name);
  const same = existing.filter((e) => e.nameNormalized === key && !e.checked);
  if (!same.length) return { kind: 'insert' };
  for (const e of same) {
    if (item.quantity === null) return { kind: 'duplicate', existingId: e.id, message: 'Уже есть в списке' };
    if (e.quantity === null) return { kind: 'duplicate', existingId: e.id, message: 'Уже есть в списке (без количества)' };
    if (item.unit === e.unit || compatibleUnits(item.unit, e.unit)) {
      if (!item.unit || !e.unit) {
        return { kind: 'merge', existingId: e.id, quantity: e.quantity + item.quantity, unit: e.unit ?? item.unit ?? 'шт', message: 'Количество добавлено к существующей позиции' };
      }
      const sum = addQuantities(e.quantity, e.unit, item.quantity, item.unit);
      return { kind: 'merge', existingId: e.id, ...sum, message: 'Количество добавлено к существующей позиции' };
    }
  }
  // same product but incompatible units → keep a separate line rather than guess
  return { kind: 'insert' };
}

const CATEGORY_RULES: [RegExp, string][] = [
  [/молок|кефир|йогурт|сыр|творог|сметан|сливк|масло сливоч|ряженк|milk|cheese|yogurt/u, 'dairy'],
  [/банан|яблок|груш|апельсин|мандарин|ягод|виноград|фрукт|овощ|помидор|томат|огур|картоф|лук|морков|капуст|салат|зелень|авокадо|перец|кабач|баклажан|чеснок|banana|apple|fruit|vegetable/u, 'produce'],
  [/мяс|куриц|курин|говяд|свин|индейк|фарш|рыб|лосос|тунец|кревет|колбас|ветчин|chicken|beef|fish|meat/u, 'meat_fish'],
  [/яйц|яиц|egg/u, 'eggs'],
  [/хлеб|батон|тост|лаваш|булк|багет|bread/u, 'bakery'],
  [/рис|гречк|макарон|паст|овсян|хлопь|мук|сахар|соль|круп|орех|гранол|мюсли|масло олив|масло подсолн|консерв|фасол|нут|чечевиц|rice|pasta|oat|nut/u, 'grocery'],
  [/вода|сок|чай|кофе|напит|морс|лимонад|water|juice|tea|coffee/u, 'drinks'],
  [/протеин|protein/u, 'protein'],
  [/бумаг|салфет|мыл|шампун|порош|средств|губк|пакет|фольг|soap|paper/u, 'household'],
];

export const SHOPPING_CATEGORY_LABELS: Record<string, string> = {
  produce: 'Овощи и фрукты',
  dairy: 'Молочное',
  eggs: 'Яйца',
  meat_fish: 'Мясо и рыба',
  bakery: 'Хлеб',
  grocery: 'Бакалея',
  drinks: 'Напитки',
  protein: 'Протеин',
  household: 'Для дома',
  other: 'Другое',
};

export function categorize(name: string): string {
  const n = name.toLowerCase().replace(/ё/g, 'е');
  for (const [re, c] of CATEGORY_RULES) if (re.test(n)) return c;
  return 'other';
}

export function formatItem(i: { name: string; quantity: number | null; unit: string | null }): string {
  if (i.quantity === null) return i.name;
  return `${i.name} — ${i.quantity}${i.unit ? ` ${i.unit}` : ''}`;
}

/** Plain-text export for copying into a messenger. */
export function listToText(title: string, items: { name: string; quantity: number | null; unit: string | null; category: string; checked: boolean }[]): string {
  const groups = new Map<string, string[]>();
  for (const i of items.filter((x) => !x.checked)) {
    const k = SHOPPING_CATEGORY_LABELS[i.category] ?? 'Другое';
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(`• ${formatItem(i)}`);
  }
  const parts = [title];
  for (const [k, lines] of groups) parts.push('', `${k}:`, ...lines);
  return parts.join('\n');
}
