import { DateTime } from 'luxon';
import { z } from 'zod';
import { parseCapture } from '@/domain/capture/parser';
import { isLowRisk, proposedActionSchema, type ParseResult, type ProposedAction } from '@/domain/capture/schema';
import { resolveDateTime } from '@/domain/capture/dates';
import { addDays, localDateOf, weekStartOf, weekdayLong, isoWeekday, zoned } from '@/domain/time';
import { withUser, type Tx } from '../db';
import { AppError, notFound } from '../http';
import { aiProvider, AIError } from '../ai/provider';
import { assertAIBudget, recordAIUsage } from '../ai/budget';
import { audit } from './audit';
import { addMeasurement } from './health';
import { logMeal } from './meals';
import { createManualEvent, loadEventRows, transitionEvent } from './planning';
import { loadContext, type UserContext } from './profile';
import { addShoppingItem } from './shopping';
import { createTask } from './tasks';

/**
 * Single inbox (PRD §6): every message first becomes a stored inbox item with proposed actions.
 * Nothing is created until confirmation (except low-risk items when the user enabled auto-apply).
 */

export interface StoredProposal {
  index: number;
  action: ProposedAction;
  status: 'pending' | 'applied' | 'skipped' | 'deferred';
  result?: { entity: string; id?: string; message: string } | null;
}

export interface InboxItemRow {
  id: string;
  kind: string;
  rawText: string | null;
  processingStatus: string;
  source: string;
  sourceRef: string | null;
  sourceMediaId: string | null;
  parser: string | null;
  proposalsJson: StoredProposal[];
  linkedEntities: { entity: string; id: string }[];
  needsConfirmation: boolean;
  error: string | null;
  createdAt: Date;
}

export const captureSchema = z.object({
  text: z.string().trim().min(1, 'Пустое сообщение').max(4000),
  idempotencyKey: z.string().max(200).optional(),
});

async function parseWithBestAvailable(
  userId: string,
  ctx: UserContext,
  now: DateTime,
  text: string,
): Promise<{ result: ParseResult; parser: string; note: string | null }> {
  const rules = parseCapture(text, { now, tz: ctx.tz, gymWindow: { earliest: ctx.prefs.targets.gymFlexEarliest, latest: ctx.prefs.targets.gymFlexLatest } });
  const ai = aiProvider();
  if (!ai.canParse() || !ctx.privacy.aiTextConsent) return { result: rules, parser: 'rules', note: null };
  try {
    await assertAIBudget(userId);
    const local = now.setZone(ctx.tz);
    const aiResult = await ai.parseIntent(text, {
      nowLocal: `${local.toFormat('yyyy-MM-dd HH:mm')}, ${weekdayLong(local.weekday)}`,
      timezone: ctx.tz,
      gymWindow: `${ctx.prefs.gymStart}–${ctx.prefs.gymEnd}`,
    });
    await recordAIUsage(userId, ai.name, 'parse_intent', true);
    // Cross-check dates with the deterministic resolver: disagreement → ask the user.
    const actions = aiResult.actions.map((a) => {
      if (!('dateLocal' in a) || !a.dateLocal || !a.sourceText) return a;
      const det = resolveDateTime(a.sourceText, now, ctx.tz);
      if (det.date && det.date !== a.dateLocal) {
        return { ...a, needsConfirmation: true, reason: `Проверь дату: по тексту получается ${det.date}` };
      }
      if (!det.date && a.dateLocal) {
        return { ...a, needsConfirmation: true, reason: a.reason ?? 'Дату предложил ИИ — проверь' };
      }
      return a;
    });
    return { result: { ...aiResult, actions }, parser: ai.name, note: null };
  } catch (e) {
    await recordAIUsage(userId, ai.name, 'parse_intent', false).catch(() => {});
    const msg = e instanceof AIError ? e.message : 'ИИ недоступен';
    return { result: rules, parser: 'rules', note: `${msg} — разобрал по правилам` };
  }
}

export function serializeInboxItem(r: InboxItemRow) {
  return { ...r, createdAt: r.createdAt.toISOString() };
}

/** Parse (outside a DB transaction — AI calls can be slow) then store the inbox item. */
export async function captureText(
  userId: string,
  now: DateTime,
  input: { text: string; idempotencyKey?: string; source?: string; sourceRef?: string | null; kind?: 'text' | 'voice' | 'photo'; mediaId?: string | null },
): Promise<{ item: InboxItemRow; note: string | null; autoApplied: boolean; duplicate: boolean }> {
  if (input.idempotencyKey) {
    const existing = await withUser(userId, (tx) => tx<InboxItemRow[]>`
      select * from inbox_items where user_id = ${userId} and idempotency_key = ${input.idempotencyKey!}`);
    if (existing[0]) return { item: existing[0], note: null, autoApplied: false, duplicate: true };
  }
  const ctx = await withUser(userId, (tx) => loadContext(tx, userId));
  const { result, parser, note } = await parseWithBestAvailable(userId, ctx, now, input.text);
  const proposals: StoredProposal[] = result.actions.map((action, index) => ({ index, action, status: 'pending', result: null }));
  const needsConfirmation = proposals.some((p) => !isLowRisk(p.action));

  return withUser(userId, async (tx) => {
    const rows = await tx<InboxItemRow[]>`
      insert into inbox_items (user_id, kind, raw_text, processing_status, source, source_ref, source_media_id, parser, proposals_json, needs_confirmation, idempotency_key, error)
      values (${userId}, ${input.kind ?? 'text'}, ${input.text}, 'proposed', ${input.source ?? 'web'}, ${input.sourceRef ?? null},
              ${input.mediaId ?? null}, ${parser}, ${tx.json(proposals as never)}, ${needsConfirmation}, ${input.idempotencyKey ?? null}, ${note})
      on conflict (user_id, idempotency_key) where idempotency_key is not null do nothing
      returning *`;
    if (!rows[0]) {
      const [ex] = await tx<InboxItemRow[]>`select * from inbox_items where user_id = ${userId} and idempotency_key = ${input.idempotencyKey ?? ''}`;
      return { item: ex!, note: null, autoApplied: false, duplicate: true };
    }
    let item = rows[0];
    let autoApplied = false;
    if (ctx.privacy.autoApplyLowRisk && !needsConfirmation && proposals.length) {
      item = (await confirmInboxItem(tx, ctx, now, item.id, { selected: proposals.map((p) => p.index) })).item;
      autoApplied = true;
    }
    return { item, note, autoApplied, duplicate: false };
  });
}

export const confirmSchema = z.object({
  selected: z.array(z.number().int().min(0)).max(20),
  edits: z.record(z.string(), proposedActionSchema).optional(),
  replaceMeasurements: z.boolean().default(false),
});
export type ConfirmInput = z.input<typeof confirmSchema>;

/**
 * Atomic batch confirmation (PRD §6.4, §17): all selected actions are applied in one transaction.
 * Re-confirming an already confirmed item returns the same result and creates nothing (idempotent).
 */
export async function confirmInboxItem(tx: Tx, ctx: UserContext, now: DateTime, id: string, raw: ConfirmInput, source: 'web' | 'telegram' = 'web') {
  const input = confirmSchema.parse(raw);
  const [item] = await tx<InboxItemRow[]>`select * from inbox_items where id = ${id} and user_id = ${ctx.userId} for update`;
  if (!item) throw notFound('Запись во входящих');
  if (item.processingStatus === 'confirmed' || item.processingStatus === 'rejected') {
    return { item, applied: [] as StoredProposal[], alreadyProcessed: true, deferred: [] as StoredProposal[] };
  }
  const proposals: StoredProposal[] = item.proposalsJson.map((p) => ({ ...p }));
  const linked: { entity: string; id: string }[] = [...item.linkedEntities];
  const deferred: StoredProposal[] = [];
  const today = localDateOf(now, ctx.tz);

  for (const p of proposals) {
    if (!input.selected.includes(p.index)) {
      p.status = 'skipped';
      continue;
    }
    const a = input.edits?.[String(p.index)] ?? p.action;
    p.action = a;
    const meta = { source, sourceMessageId: item.sourceRef, inboxItemId: item.id };
    switch (a.type) {
      case 'create_task': {
        const t = await createTask(tx, ctx, { title: a.title, type: a.taskType, category: a.category, priority: a.priority, dueDate: a.dateLocal, dueTime: a.timeLocal }, meta);
        linked.push({ entity: 'task', id: t.id });
        p.result = { entity: 'task', id: t.id, message: 'Задача создана' };
        break;
      }
      case 'create_waiting': {
        const t = await createTask(tx, ctx, { title: a.title, type: 'waiting', category: a.category, priority: 'normal', waitingFor: a.waitingFor, followUpDate: a.followUpDate ?? addDays(today, 3) }, meta);
        linked.push({ entity: 'task', id: t.id });
        p.result = { entity: 'task', id: t.id, message: 'Ожидание с датой проверки' };
        break;
      }
      case 'add_shopping_item': {
        const r = await addShoppingItem(tx, ctx, now, { name: a.title, quantity: a.quantity, unit: a.unit, listType: a.listType }, source === 'telegram' ? 'telegram' : 'voice_text');
        if (r.outcome !== 'duplicate') linked.push({ entity: 'shopping_item', id: r.item.id });
        p.result = { entity: 'shopping_item', id: r.item.id, message: r.message };
        break;
      }
      case 'log_weight':
      case 'log_steps': {
        const m = await addMeasurement(tx, ctx, now, {
          metricType: a.type === 'log_weight' ? 'weight' : 'steps',
          value: a.value,
          localDate: a.dateLocal ?? today,
          sourceType: source === 'telegram' ? 'telegram' : 'manual',
          replace: input.replaceMeasurements,
        });
        linked.push({ entity: 'health_measurement', id: m.id });
        p.result = { entity: 'health_measurement', id: m.id, message: 'Измерение сохранено' };
        break;
      }
      case 'log_meal': {
        const date = a.dateLocal ?? today;
        const kind = `meal_${a.slot}`;
        const [ev] = await tx<{ id: string }[]>`
          select id from schedule_events where user_id = ${ctx.userId} and local_date = ${date}
            and kind = ${a.slot === 'snack' ? 'snack' : kind} and status not in ('completed','skipped','cancelled')
          order by start_at limit 1`;
        const log = await logMeal(tx, ctx, now, { eventId: ev?.id ?? null, localDate: date, slot: a.slot, consumptionStatus: 'all', description: a.description, drinks: [] }, source);
        linked.push({ entity: 'meal_log', id: log.id });
        p.result = { entity: 'meal_log', id: log.id, message: 'Приём пищи отмечен' };
        break;
      }
      case 'schedule_workout': {
        if (!a.dateLocal) throw new AppError('DATE_REQUIRED', `Укажи день для «${a.title}»`, 422, { index: p.index });
        const time = a.timeLocal ?? ctx.prefs.gymStart;
        const ws = weekStartOf(a.dateLocal);
        const rows = await loadEventRows(tx, ctx.userId, zoned(ws, '00:00', ctx.tz), zoned(addDays(ws, 7), '00:00', ctx.tz));
        // move an open workout of that week (keeps the weekly quota intact) or add a new one
        const open = rows
          .filter((r) => r.kind === 'workout' && ['planned', 'notified', 'snoozed', 'rescheduled', 'unanswered'].includes(r.status))
          .sort((x, y) => Number(y.localDate === a.dateLocal) - Number(x.localDate === a.dateLocal) || x.startAt.getTime() - y.startAt.getTime())[0];
        const sameSlot = open && open.localDate === a.dateLocal && DateTime.fromJSDate(open.startAt).setZone(ctx.tz).toFormat('HH:mm') === time;
        if (open && sameSlot) {
          linked.push({ entity: 'schedule_event', id: open.id });
          p.result = { entity: 'schedule_event', id: open.id, message: 'Уже в плане — ничего не менял' };
        } else if (open) {
          const r = await transitionEvent(tx, ctx, now, open.id, { action: 'reschedule', toDate: a.dateLocal, toTime: time, reason: 'Из входящих' }, source);
          linked.push({ entity: 'schedule_event', id: open.id });
          p.result = { entity: 'schedule_event', id: open.id, message: `Тренировка перенесена на ${weekdayLong(isoWeekday(a.dateLocal))} ${time}${r.warnings.length ? ` (${r.warnings.join(' ')})` : ''}` };
        } else {
          const dur = ctx.prefs.targets.workoutMinutes;
          const r = await createManualEvent(tx, ctx, now, { date: a.dateLocal, startTime: time, durationMinutes: dur, title: 'Тренировка', kind: 'workout', priorityClass: 'required_movable' }, source);
          linked.push({ entity: 'schedule_event', id: r.event.id });
          p.result = { entity: 'schedule_event', id: r.event.id, message: `Тренировка добавлена${r.warnings.length ? ` (${r.warnings.join(' ')})` : ''}` };
        }
        break;
      }
      case 'extra_work': {
        p.status = 'deferred';
        p.result = { entity: 'extra_work', message: 'Открой предпросмотр «Нужно поработать» и подтверди' };
        deferred.push(p);
        continue;
      }
      case 'idea': {
        const t = await createTask(tx, ctx, { title: a.title, type: a.category === 'wish' ? 'wish' : 'idea', category: a.category, priority: 'low' }, meta);
        linked.push({ entity: 'task', id: t.id });
        p.result = { entity: 'task', id: t.id, message: 'Идея сохранена без срока' };
        break;
      }
      case 'note': {
        const t = await createTask(tx, ctx, { title: a.text.slice(0, 500), type: 'task', category: 'personal', priority: 'normal', status: 'inbox' }, meta);
        linked.push({ entity: 'task', id: t.id });
        p.result = { entity: 'task', id: t.id, message: 'Сохранено во входящие' };
        break;
      }
    }
    p.status = 'applied';
  }

  const [updated] = await tx<InboxItemRow[]>`
    update inbox_items set processing_status = 'confirmed', proposals_json = ${tx.json(proposals as never)},
      linked_entities = ${tx.json(linked as never)}, needs_confirmation = false
    where id = ${id} returning *`;
  await audit(tx, ctx.userId, 'inbox_item', id, 'confirmed', { applied: proposals.filter((p) => p.status === 'applied').length }, source);
  return { item: updated!, applied: proposals.filter((p) => p.status === 'applied'), alreadyProcessed: false, deferred };
}

export async function rejectInboxItem(tx: Tx, userId: string, id: string) {
  const rows = await tx`update inbox_items set processing_status = 'rejected' where id = ${id} and user_id = ${userId}
                        and processing_status not in ('confirmed') returning id`;
  if (!rows.length) throw notFound('Запись во входящих');
}

export async function listPendingInbox(tx: Tx, userId: string, limit = 20) {
  return tx<InboxItemRow[]>`
    select * from inbox_items where user_id = ${userId} and processing_status in ('proposed', 'received', 'failed')
    order by created_at desc limit ${limit}`;
}

export async function getInboxItem(tx: Tx, userId: string, id: string) {
  const [r] = await tx<InboxItemRow[]>`select * from inbox_items where id = ${id} and user_id = ${userId}`;
  if (!r) throw notFound('Запись во входящих');
  return r;
}

export { DateTime };
