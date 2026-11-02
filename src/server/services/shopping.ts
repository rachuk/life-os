import { z } from 'zod';
import { parseShoppingItem } from '@/domain/capture/parser';
import {
  aggregateMenu,
  MENU_SOURCE,
  planMenuSync,
  summarizeSync,
  syncSummaryText,
  type ListType,
  type MenuIngredient,
  type MenuPick,
  type SyncSummary,
} from '@/domain/shopping/fromMenu';
import { categorize, decideMerge, listToText, normalizeProductName } from '@/domain/shopping/normalize';
import { isLocalDate, localDateOf, weekStartOf, type LocalDate } from '@/domain/time';
import type { DateTime } from 'luxon';
import { one, type Tx } from '../db';
import { AppError, notFound } from '../http';
import { audit } from './audit';
import type { UserContext } from './profile';

export interface ShoppingItemRow {
  id: string;
  listId: string;
  name: string;
  nameNormalized: string;
  quantity: number | null;
  unit: string | null;
  category: string;
  checked: boolean;
  checkedAt: Date | null;
  source: string;
  notes: string | null;
  createdAt: Date;
}

export interface ShoppingListRow {
  id: string;
  weekStart: string;
  name: string;
  listType: 'personal' | 'household';
  status: string;
}

export const addItemSchema = z.object({
  name: z.string().trim().min(1).max(200),
  quantity: z.number().positive().max(10000).nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  listType: z.enum(['personal', 'household']).default('personal'),
  weekStart: z.string().refine(isLocalDate, 'Дата YYYY-MM-DD').optional(),
  notes: z.string().max(300).nullable().optional(),
});

const LIST_NAMES = { personal: 'Личная корзина', household: 'Общая домашняя' } as const;

export async function ensureList(tx: Tx, userId: string, weekStart: LocalDate, listType: 'personal' | 'household'): Promise<ShoppingListRow> {
  await tx`insert into shopping_lists (user_id, week_start, name, list_type) values (${userId}, ${weekStart}, ${LIST_NAMES[listType]}, ${listType})
           on conflict (user_id, week_start, list_type) do nothing`;
  return one(await tx<ShoppingListRow[]>`
    select id, week_start, name, list_type, status from shopping_lists
    where user_id = ${userId} and week_start = ${weekStart} and list_type = ${listType}`);
}

export interface AddResult {
  item: ShoppingItemRow;
  outcome: 'inserted' | 'merged' | 'duplicate';
  message: string;
}

export async function addShoppingItem(
  tx: Tx,
  ctx: UserContext,
  now: DateTime,
  input: z.infer<typeof addItemSchema>,
  source = 'manual',
): Promise<AddResult> {
  const week = weekStartOf(input.weekStart ?? localDateOf(now, ctx.tz));
  const list = await ensureList(tx, ctx.userId, week, input.listType);
  // lock the list so two concurrent adds cannot both insert the same product
  await tx`select id from shopping_lists where id = ${list.id} for update`;
  const existing = await tx<ShoppingItemRow[]>`select * from shopping_items where list_id = ${list.id}`;
  const decision = decideMerge({ name: input.name, quantity: input.quantity ?? null, unit: input.unit ?? null }, existing);
  if (decision.kind === 'duplicate') {
    return { item: existing.find((e) => e.id === decision.existingId)!, outcome: 'duplicate', message: decision.message };
  }
  if (decision.kind === 'merge') {
    const item = one(await tx<ShoppingItemRow[]>`
      update shopping_items set quantity = ${decision.quantity}, unit = ${decision.unit},
        source = case when source = ${MENU_SOURCE} then ${source} else source end
      where id = ${decision.existingId} returning *`);
    return { item, outcome: 'merged', message: decision.message };
  }
  const item = one(await tx<ShoppingItemRow[]>`
    insert into shopping_items (user_id, list_id, name, name_normalized, quantity, unit, category, source, notes)
    values (${ctx.userId}, ${list.id}, ${input.name}, ${normalizeProductName(input.name)}, ${input.quantity ?? null},
            ${input.unit ?? null}, ${categorize(input.name)}, ${source}, ${input.notes ?? null})
    returning *`);
  return { item, outcome: 'inserted', message: 'Добавлено' };
}

export async function getWeekLists(tx: Tx, userId: string, weekStart: LocalDate) {
  const lists = await tx<ShoppingListRow[]>`
    select id, week_start, name, list_type, status from shopping_lists where user_id = ${userId} and week_start = ${weekStart}
    order by list_type desc`;
  const items = lists.length
    ? await tx<ShoppingItemRow[]>`select * from shopping_items where list_id = any(${lists.map((l) => l.id)}) order by checked, category, created_at`
    : [];
  return lists.map((l) => {
    const its = items.filter((i) => i.listId === l.id);
    return { ...l, items: its, text: listToText(`${l.name} (неделя с ${l.weekStart})`, its) };
  });
}

export async function setItemChecked(tx: Tx, userId: string, id: string, checked: boolean) {
  const rows = await tx<ShoppingItemRow[]>`
    update shopping_items set checked = ${checked}, checked_at = ${checked ? new Date() : null}
    where id = ${id} and user_id = ${userId} returning *`;
  if (!rows.length) throw notFound('Покупка');
  return rows[0]!;
}

export async function updateItem(tx: Tx, userId: string, id: string, patch: { name?: string; quantity?: number | null; unit?: string | null; notes?: string | null }) {
  const [cur] = await tx<ShoppingItemRow[]>`select * from shopping_items where id = ${id} and user_id = ${userId}`;
  if (!cur) throw notFound('Покупка');
  const name = patch.name ?? cur.name;
  // a line generated from the menu that the user edited by hand is theirs now: regeneration keeps it
  const source = cur.source === MENU_SOURCE && (patch.name !== undefined || patch.quantity !== undefined || patch.unit !== undefined) ? 'manual' : cur.source;
  return one(await tx<ShoppingItemRow[]>`
    update shopping_items set name = ${name}, name_normalized = ${normalizeProductName(name)},
      quantity = ${patch.quantity !== undefined ? patch.quantity : cur.quantity}, unit = ${patch.unit !== undefined ? patch.unit || null : cur.unit},
      notes = ${patch.notes !== undefined ? patch.notes : cur.notes},
      category = ${categorize(name)}, source = ${source}
    where id = ${id} returning *`);
}

export async function deleteItem(tx: Tx, userId: string, id: string) {
  const rows = await tx`delete from shopping_items where id = ${id} and user_id = ${userId} returning id`;
  if (!rows.length) throw notFound('Покупка');
}

export const generateSchema = z.object({
  weekStart: z.string().refine(isLocalDate, 'Дата YYYY-MM-DD'),
  picks: z.array(z.object({ templateId: z.string().uuid(), times: z.number().int().min(0).max(21) })).max(60),
});

/**
 * «Собрать из меню»: the menu part of the week lists is recomputed from templates × times
 * (see domain/shopping/fromMenu). Idempotent — repeating it never duplicates or doubles (HEALTH-08).
 * Personal templates go to the personal basket, lunch/dinner ingredients to the household one.
 */
export async function addFromMealTemplates(
  tx: Tx,
  ctx: UserContext,
  _now: DateTime,
  weekStartRaw: LocalDate,
  picks: { templateId: string; times: number }[],
): Promise<SyncSummary & { text: string }> {
  const weekStart = weekStartOf(weekStartRaw);
  const ids = [...new Set(picks.map((p) => p.templateId))];
  const templates = ids.length
    ? await tx<{ id: string; category: string; ingredientsJson: MenuIngredient[] }[]>`
        select id, category, ingredients_json from meal_templates where user_id = ${ctx.userId} and id = any(${ids})`
    : [];
  const byId = new Map(templates.map((t) => [t.id, t]));
  const menuPicks: MenuPick[] = [];
  for (const p of picks) {
    const t = byId.get(p.templateId);
    if (t) menuPicks.push({ templateId: t.id, category: t.category, times: p.times, ingredients: t.ingredientsJson ?? [] });
  }
  const lines = aggregateMenu(menuPicks);
  const lists = {
    personal: await ensureList(tx, ctx.userId, weekStart, 'personal'),
    household: await ensureList(tx, ctx.userId, weekStart, 'household'),
  };
  await tx`select id from shopping_lists where id = any(${[lists.personal.id, lists.household.id]}) for update`;
  const listTypeById = new Map<string, ListType>([
    [lists.personal.id, 'personal'],
    [lists.household.id, 'household'],
  ]);
  const existing = (await tx<ShoppingItemRow[]>`select * from shopping_items where list_id = any(${[...listTypeById.keys()]})`).map((i) => ({
    ...i,
    listType: listTypeById.get(i.listId)!,
  }));
  const actions = planMenuSync(lines, existing);
  for (const a of actions) {
    if (a.kind === 'insert') {
      const l = a.line;
      await tx`
        insert into shopping_items (user_id, list_id, name, name_normalized, quantity, unit, category, source, source_meal_id, notes)
        values (${ctx.userId}, ${lists[l.listType].id}, ${l.name}, ${l.nameNormalized}, ${l.quantity}, ${l.unit}, ${categorize(l.name)},
                ${MENU_SOURCE}, ${l.templateIds[0] ?? null}, ${CHECK_AT_HOME})`;
    } else if (a.kind === 'update') {
      await tx`update shopping_items set quantity = ${a.line.quantity}, unit = ${a.line.unit} where id = ${a.existingId} and user_id = ${ctx.userId}`;
    } else if (a.kind === 'remove') {
      await tx`delete from shopping_items where id = ${a.existingId} and user_id = ${ctx.userId} and source = ${MENU_SOURCE} and not checked`;
    }
  }
  const summary = summarizeSync(actions);
  await audit(tx, ctx.userId, 'shopping_list', lists.personal.id, 'generated_from_menu', {
    inserted: summary.inserted,
    updated: summary.updated,
    removed: summary.removed,
    skipped: summary.skipped,
  });
  return { ...summary, text: syncSummaryText(summary) };
}

export const CHECK_AT_HOME = 'Проверь дома';

export function serializeShoppingItem(i: ShoppingItemRow) {
  return { ...i, checkedAt: i.checkedAt?.toISOString() ?? null, createdAt: i.createdAt.toISOString() };
}
export type SerializedShoppingItem = ReturnType<typeof serializeShoppingItem>;

/** Both baskets of a week, always present (a list row is created lazily on first add). */
export async function weekShopping(tx: Tx, userId: string, weekStartRaw: LocalDate) {
  const weekStart = weekStartOf(weekStartRaw);
  const lists = await getWeekLists(tx, userId, weekStart);
  const types: ListType[] = ['personal', 'household'];
  return {
    weekStart,
    lists: types.map((t) => {
      const l = lists.find((x) => x.listType === t);
      const items = l?.items ?? [];
      return {
        listType: t,
        id: l?.id ?? null,
        name: LIST_NAMES[t],
        items: items.map(serializeShoppingItem),
        text: l?.text ?? listToText(`${LIST_NAMES[t]} (неделя с ${weekStart})`, []),
        open: items.filter((i) => !i.checked).length,
        bought: items.filter((i) => i.checked).length,
      };
    }),
  };
}

export const addTextSchema = z.object({
  text: z.string().trim().min(1).max(200),
  listType: z.enum(['personal', 'household']).default('personal'),
  weekStart: z.string().refine(isLocalDate, 'Дата YYYY-MM-DD').optional(),
});

/** "молоко 2 л" → name + quantity + unit, then the usual dedupe/merge rules. */
export async function addShoppingText(tx: Tx, ctx: UserContext, now: DateTime, input: z.infer<typeof addTextSchema>) {
  const parsed = parseShoppingItem(input.text);
  if (!parsed.title.trim()) throw new AppError('EMPTY_ITEM', 'Напиши, что купить', 422);
  return addShoppingItem(tx, ctx, now, {
    name: parsed.title,
    quantity: parsed.quantity,
    unit: parsed.unit,
    listType: input.listType,
    weekStart: input.weekStart ? weekStartOf(input.weekStart) : undefined,
  });
}

export const itemPatchSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  quantity: z.number().positive().max(10000).nullable().optional(),
  unit: z.string().trim().max(20).nullable().optional(),
  notes: z.string().max(300).nullable().optional(),
});
