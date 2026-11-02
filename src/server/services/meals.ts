import type { DateTime } from 'luxon';
import { z } from 'zod';
import { isLocalDate, localDateOf, type LocalDate } from '@/domain/time';
import type { MealSlot } from '@/domain/types';
import { mealSlotOfKind } from '@/domain/types';
import { one, type Tx } from '../db';
import { AppError } from '../http';
import { audit } from './audit';
import { transitionEvent } from './planning';
import type { UserContext } from './profile';

const templateNotFound = () => new AppError('NOT_FOUND', 'Шаблон не найден', 404);

export const mealLogSchema = z.object({
  eventId: z.string().uuid().nullable().optional(),
  localDate: z.string().refine(isLocalDate).optional(),
  slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'post_workout']).optional(),
  consumptionStatus: z.enum(['all', 'part', 'replaced', 'not_eaten']),
  description: z.string().trim().max(500).nullable().optional(),
  portionFraction: z.number().min(0).max(1).nullable().optional(),
  drinks: z.array(z.object({ name: z.string().max(60), ml: z.number().int().min(0).max(3000).nullable().optional() })).max(10).default([]),
  mediaId: z.string().uuid().nullable().optional(),
  reason: z.string().trim().max(200).nullable().optional(),
});
export type MealLogInput = z.infer<typeof mealLogSchema>;

export interface MealLogRow {
  id: string;
  scheduleEventId: string | null;
  localDate: string;
  mealSlot: MealSlot;
  eatenAt: Date;
  description: string | null;
  consumptionStatus: string;
  portionFraction: number | null;
  drinksJson: { name: string; ml?: number | null }[];
  mediaId: string | null;
  source: string;
}

/** The only place a meal becomes "eaten": an explicit consumption answer (HEALTH-03). */
export async function logMeal(tx: Tx, ctx: UserContext, now: DateTime, input: MealLogInput, source: 'web' | 'telegram' = 'web') {
  let slot = input.slot ?? null;
  let localDate = input.localDate ?? localDateOf(now, ctx.tz);
  if (input.eventId) {
    const [ev] = await tx<{ id: string; kind: string; localDate: string }[]>`
      select id, kind, local_date from schedule_events where id = ${input.eventId} and user_id = ${ctx.userId}`;
    if (!ev) throw new AppError('NOT_FOUND', 'Приём пищи не найден', 404);
    slot = mealSlotOfKind(ev.kind) ?? slot;
    localDate = ev.localDate;
  }
  if (!slot) throw new AppError('SLOT_REQUIRED', 'Укажи приём пищи', 422);
  if (input.mediaId) {
    const [m] = await tx`select id from media_assets where id = ${input.mediaId} and user_id = ${ctx.userId}`;
    if (!m) throw new AppError('NOT_FOUND', 'Фото не найдено', 404);
  }
  const row = one(await tx<MealLogRow[]>`
    insert into meal_logs (user_id, schedule_event_id, local_date, meal_slot, eaten_at, description, consumption_status, portion_fraction, drinks_json, media_id, source)
    values (${ctx.userId}, ${input.eventId ?? null}, ${localDate}, ${slot}, ${now.toJSDate()}, ${input.description ?? null},
            ${input.consumptionStatus}, ${input.portionFraction ?? null}, ${tx.json(input.drinks as never)}, ${input.mediaId ?? null}, ${source})
    returning *`);
  if (input.mediaId) await tx`update media_assets set processing_status = 'logged' where id = ${input.mediaId}`;
  if (input.eventId) {
    const [ev] = await tx<{ status: string }[]>`select status from schedule_events where id = ${input.eventId}`;
    const settled = ev && ['completed', 'skipped', 'cancelled'].includes(ev.status);
    if (!settled) {
      await transitionEvent(
        tx,
        ctx,
        now,
        input.eventId,
        input.consumptionStatus === 'not_eaten'
          ? { action: 'skip', reason: input.reason ?? 'Не ел' }
          : { action: 'complete', reason: input.consumptionStatus === 'all' ? null : input.consumptionStatus === 'part' ? 'Съел часть' : 'Заменил блюдо' },
        source,
      );
    }
  }
  await audit(tx, ctx.userId, 'meal_log', row.id, 'created', { slot, status: input.consumptionStatus }, source);
  return row;
}

export async function listMealLogs(tx: Tx, userId: string, from: LocalDate, to: LocalDate) {
  return tx<MealLogRow[]>`select * from meal_logs where user_id = ${userId} and local_date between ${from} and ${to} order by eaten_at`;
}

export const mealTemplateSchema = z.object({
  title: z.string().trim().min(1).max(200),
  category: z.enum(['breakfast', 'snack', 'lunch', 'dinner', 'drink', 'post_workout']),
  ingredients: z.array(z.object({ name: z.string().trim().min(1).max(100), quantity: z.number().positive().nullable(), unit: z.string().max(20).nullable() })).max(30).default([]),
  prepMinutes: z.number().int().min(0).max(300).nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
  enabled: z.boolean().default(true),
});

export async function listMealTemplates(tx: Tx, userId: string) {
  return tx<{ id: string; title: string; category: string; ingredientsJson: { name: string; quantity: number | null; unit: string | null }[]; prepMinutes: number | null; notes: string | null; isExample: boolean; enabled: boolean }[]>`
    select id, title, category, ingredients_json, prep_minutes, notes, is_example, enabled from meal_templates
    where user_id = ${userId} order by category, title`;
}

export async function upsertMealTemplate(tx: Tx, userId: string, id: string | null, input: z.infer<typeof mealTemplateSchema>) {
  if (id) {
    const rows = await tx`
      update meal_templates set title = ${input.title}, category = ${input.category}, ingredients_json = ${tx.json(input.ingredients as never)},
        prep_minutes = ${input.prepMinutes ?? null}, notes = ${input.notes ?? null}, enabled = ${input.enabled}, is_example = false
      where id = ${id} and user_id = ${userId} returning id`;
    if (!rows.length) throw templateNotFound();
    return id;
  }
  const [r] = await tx<{ id: string }[]>`
    insert into meal_templates (user_id, title, category, ingredients_json, prep_minutes, notes, enabled)
    values (${userId}, ${input.title}, ${input.category}, ${tx.json(input.ingredients as never)}, ${input.prepMinutes ?? null}, ${input.notes ?? null}, ${input.enabled})
    returning id`;
  return r!.id;
}

export async function setMealPlan(tx: Tx, userId: string, input: { localDate: LocalDate; slot: MealSlot; templateId?: string | null; description?: string | null }) {
  if (input.slot === 'snack') throw new AppError('BAD_SLOT', 'Для перекусов план не задаётся', 422);
  await tx`
    insert into meal_plan_entries (user_id, local_date, meal_slot, template_id, description)
    values (${userId}, ${input.localDate}, ${input.slot}, ${input.templateId ?? null}, ${input.description ?? null})
    on conflict (user_id, local_date, meal_slot) where meal_slot <> 'snack'
    do update set template_id = excluded.template_id, description = excluded.description`;
}

export async function mealPlanForRange(tx: Tx, userId: string, from: LocalDate, to: LocalDate) {
  return tx<{ localDate: string; mealSlot: MealSlot; templateId: string | null; description: string | null; templateTitle: string | null }[]>`
    select e.local_date, e.meal_slot, e.template_id, e.description, t.title as template_title
    from meal_plan_entries e left join meal_templates t on t.id = e.template_id
    where e.user_id = ${userId} and e.local_date between ${from} and ${to}`;
}

export const mealTemplatePatchSchema = mealTemplateSchema.partial();

/** Toggling «включено» keeps the «пример» flag; any content edit makes the template the user's own. */
export async function patchMealTemplate(tx: Tx, userId: string, id: string, patch: z.infer<typeof mealTemplatePatchSchema>) {
  const keys = Object.keys(patch).filter((k) => (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length === 1 && keys[0] === 'enabled') {
    const rows = await tx`update meal_templates set enabled = ${patch.enabled!} where id = ${id} and user_id = ${userId} returning id`;
    if (!rows.length) throw templateNotFound();
    return id;
  }
  const [cur] = await listMealTemplateById(tx, userId, id);
  if (!cur) throw templateNotFound();
  const merged = mealTemplateSchema.parse({
    title: cur.title,
    category: cur.category,
    ingredients: cur.ingredientsJson,
    prepMinutes: cur.prepMinutes,
    notes: cur.notes,
    enabled: cur.enabled,
    ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)),
  });
  return upsertMealTemplate(tx, userId, id, merged);
}

function listMealTemplateById(tx: Tx, userId: string, id: string) {
  return tx<{ id: string; title: string; category: string; ingredientsJson: { name: string; quantity: number | null; unit: string | null }[]; prepMinutes: number | null; notes: string | null; isExample: boolean; enabled: boolean }[]>`
    select id, title, category, ingredients_json, prep_minutes, notes, is_example, enabled from meal_templates
    where id = ${id} and user_id = ${userId}`;
}

export async function deleteMealTemplate(tx: Tx, userId: string, id: string) {
  const rows = await tx`delete from meal_templates where id = ${id} and user_id = ${userId} returning id`;
  if (!rows.length) throw templateNotFound();
  await audit(tx, userId, 'meal_template', id, 'deleted', {});
}

export const mealPlanSchema = z.object({
  localDate: z.string().refine(isLocalDate),
  slot: z.enum(['breakfast', 'lunch', 'dinner', 'post_workout']),
  templateId: z.string().uuid().nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
});

/**
 * Planned dish for a day + slot. Planning never marks anything eaten (HEALTH-03); an empty choice
 * clears the entry, which for lunch/dinner means the default «Домашнее блюдо — уточнить по факту».
 */
export async function planMeal(tx: Tx, userId: string, input: z.infer<typeof mealPlanSchema>) {
  const templateId = input.templateId ?? null;
  const description = input.description?.trim() || null;
  if (templateId) {
    const [t] = await listMealTemplateById(tx, userId, templateId);
    if (!t) throw templateNotFound();
  }
  if (!templateId && !description) {
    await tx`delete from meal_plan_entries where user_id = ${userId} and local_date = ${input.localDate} and meal_slot = ${input.slot}`;
    return;
  }
  await setMealPlan(tx, userId, { localDate: input.localDate, slot: input.slot, templateId, description });
}

export function serializeMealLog(r: MealLogRow) {
  return { ...r, eatenAt: r.eatenAt.toISOString() };
}

export const HOME_DISH_DEFAULT = 'Домашнее блюдо — уточнить по факту';

/** Logs + plan + templates for a date range (meals page, /api/meals). */
export async function mealsRange(tx: Tx, userId: string, from: LocalDate, to: LocalDate) {
  const logs = await listMealLogs(tx, userId, from, to);
  const plan = await mealPlanForRange(tx, userId, from, to);
  const templates = await listMealTemplates(tx, userId);
  return { from, to, logs: logs.map(serializeMealLog), plan, templates };
}
