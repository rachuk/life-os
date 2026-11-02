import { addQuantities, compatibleUnits, formatItem, normalizeProductName } from './normalize';

/**
 * «Собрать из меню» (PRD §9.1–9.4, HEALTH-08). The menu part of a week list is recomputed as a
 * whole from the chosen templates × times, so pressing the button twice never doubles anything:
 *  - lines generated earlier are updated in place (or removed if the dish left the menu and the line
 *    was not bought yet);
 *  - a product the user added by hand is never touched — we only say how much the menu needs;
 *  - a product already marked bought is not re-added (stock is unknown → «проверь дома»).
 */

export type ListType = 'personal' | 'household';

export interface MenuIngredient {
  name: string;
  quantity: number | null;
  unit: string | null;
}

export interface MenuPick {
  templateId: string;
  category: string;
  times: number;
  ingredients: MenuIngredient[];
}

/** Breakfasts, snacks and drinks are personal; shared home cooking goes to the household basket. */
export function listTypeForCategory(category: string): ListType {
  return category === 'lunch' || category === 'dinner' ? 'household' : 'personal';
}

export interface MenuLine {
  listType: ListType;
  name: string;
  nameNormalized: string;
  quantity: number | null;
  unit: string | null;
  templateIds: string[];
}

function unitsMatch(a: string | null, b: string | null): boolean {
  if (a === b) return true;
  return compatibleUnits(a, b);
}

function sum(q1: number, u1: string | null, q2: number, u2: string | null): { quantity: number; unit: string | null } {
  if (u1 && u2 && compatibleUnits(u1, u2)) return addQuantities(q1, u1, q2, u2);
  return { quantity: Math.round((q1 + q2) * 1000) / 1000, unit: u1 ?? u2 };
}

export function aggregateMenu(picks: MenuPick[]): MenuLine[] {
  const lines: MenuLine[] = [];
  for (const p of picks) {
    const times = Math.max(0, Math.floor(p.times));
    if (!times) continue;
    const listType = listTypeForCategory(p.category);
    for (const ing of p.ingredients) {
      const nameNormalized = normalizeProductName(ing.name);
      if (!nameNormalized) continue;
      const qty = ing.quantity !== null ? Math.round(ing.quantity * times * 1000) / 1000 : null;
      const same = lines.find(
        (l) => l.listType === listType && l.nameNormalized === nameNormalized && (l.quantity === null || qty === null || unitsMatch(l.unit, ing.unit)),
      );
      if (!same) {
        lines.push({ listType, name: ing.name.trim(), nameNormalized, quantity: qty, unit: qty === null ? null : ing.unit, templateIds: [p.templateId] });
        continue;
      }
      if (!same.templateIds.includes(p.templateId)) same.templateIds.push(p.templateId);
      if (qty === null) continue;
      if (same.quantity === null) {
        same.quantity = qty;
        same.unit = ing.unit;
      } else {
        const s = sum(same.quantity, same.unit, qty, ing.unit);
        same.quantity = s.quantity;
        same.unit = s.unit;
      }
    }
  }
  return lines;
}

export interface ExistingListItem {
  id: string;
  listType: ListType;
  name: string;
  nameNormalized: string;
  quantity: number | null;
  unit: string | null;
  checked: boolean;
  source: string;
}

export const MENU_SOURCE = 'meal_template';

export type SyncAction =
  | { kind: 'insert'; line: MenuLine }
  | { kind: 'update'; line: MenuLine; existingId: string }
  | { kind: 'unchanged'; line: MenuLine; existingId: string }
  | { kind: 'skip_manual'; line: MenuLine; existingId: string; message: string }
  | { kind: 'skip_bought'; line: MenuLine; existingId: string; message: string }
  | { kind: 'remove'; existingId: string; name: string };

function matches(line: MenuLine, e: ExistingListItem): boolean {
  return (
    e.listType === line.listType &&
    e.nameNormalized === line.nameNormalized &&
    (line.quantity === null || e.quantity === null || unitsMatch(line.unit, e.unit))
  );
}

export function planMenuSync(lines: MenuLine[], existing: ExistingListItem[]): SyncAction[] {
  const actions: SyncAction[] = [];
  const used = new Set<string>();
  for (const line of lines) {
    const candidates = existing.filter((e) => !used.has(e.id) && matches(line, e));
    const generated = candidates.find((e) => e.source === MENU_SOURCE && !e.checked);
    if (generated) {
      used.add(generated.id);
      const same = generated.quantity === line.quantity && (generated.unit ?? null) === (line.unit ?? null);
      actions.push(same ? { kind: 'unchanged', line, existingId: generated.id } : { kind: 'update', line, existingId: generated.id });
      continue;
    }
    const manual = candidates.find((e) => !e.checked);
    if (manual) {
      used.add(manual.id);
      actions.push({
        kind: 'skip_manual',
        line,
        existingId: manual.id,
        message: `«${manual.name}» уже в списке — проверь количество (по меню: ${formatItem(line)})`,
      });
      continue;
    }
    const bought = candidates.find((e) => e.checked);
    if (bought) {
      used.add(bought.id);
      actions.push({
        kind: 'skip_bought',
        line,
        existingId: bought.id,
        message: `«${bought.name}» уже отмечено купленным — если нужно больше, добавь вручную`,
      });
      continue;
    }
    actions.push({ kind: 'insert', line });
  }
  for (const e of existing) {
    if (e.source === MENU_SOURCE && !e.checked && !used.has(e.id)) actions.push({ kind: 'remove', existingId: e.id, name: e.name });
  }
  return actions;
}

export interface SyncSummary {
  inserted: number;
  updated: number;
  unchanged: number;
  removed: number;
  skipped: number;
  messages: string[];
}

export function summarizeSync(actions: SyncAction[]): SyncSummary {
  const s: SyncSummary = { inserted: 0, updated: 0, unchanged: 0, removed: 0, skipped: 0, messages: [] };
  for (const a of actions) {
    if (a.kind === 'insert') s.inserted++;
    else if (a.kind === 'update') s.updated++;
    else if (a.kind === 'unchanged') s.unchanged++;
    else if (a.kind === 'remove') s.removed++;
    else {
      s.skipped++;
      s.messages.push(a.message);
    }
  }
  return s;
}

export function syncSummaryText(s: SyncSummary): string {
  const parts: string[] = [];
  if (s.inserted) parts.push(`добавлено ${s.inserted}`);
  if (s.updated) parts.push(`обновлено ${s.updated}`);
  if (s.removed) parts.push(`убрано ${s.removed} (их больше нет в меню)`);
  if (s.unchanged) parts.push(`без изменений ${s.unchanged}`);
  if (s.skipped) parts.push(`не дублировали ${s.skipped}`);
  return parts.length ? `Список по меню: ${parts.join(', ')}.` : 'В выбранных блюдах нет ингредиентов.';
}
