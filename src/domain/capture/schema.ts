import { z } from 'zod';
import { isLocalDate, isLocalTime } from '../time';

/**
 * The single contract for "proposed actions" (PRD §18.2). Both the deterministic rule parser and
 * any AI provider must produce exactly this shape; unknown fields are stripped, dangerous action
 * types (delete, money transfer) simply do not exist in the schema.
 */

const localDate = z.string().refine(isLocalDate, 'YYYY-MM-DD').nullable();
const localTime = z.string().refine(isLocalTime, 'HH:mm').nullable();

export const TASK_CATEGORIES = [
  'personal',
  'health',
  'finance',
  'household',
  'work_reminder',
  'own_project',
  'shopping',
  'idea',
  'wish',
  'event',
] as const;

const base = {
  sourceText: z.string().max(1000).default(''),
  needsConfirmation: z.boolean().default(true),
  reason: z.string().max(300).nullable().default(null),
};

export const proposedActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('create_task'),
    title: z.string().min(1).max(300),
    taskType: z.enum(['task', 'reminder']).default('task'),
    category: z.enum(TASK_CATEGORIES).default('personal'),
    dateLocal: localDate.default(null),
    timeLocal: localTime.default(null),
    priority: z.enum(['low', 'normal', 'high']).default('normal'),
    ...base,
  }),
  z.object({
    type: z.literal('create_waiting'),
    title: z.string().min(1).max(300),
    waitingFor: z.string().max(200).nullable().default(null),
    followUpDate: localDate.default(null),
    category: z.enum(TASK_CATEGORIES).default('personal'),
    ...base,
  }),
  z.object({
    type: z.literal('add_shopping_item'),
    title: z.string().min(1).max(200),
    quantity: z.number().positive().max(10000).nullable().default(null),
    unit: z.string().max(20).nullable().default(null),
    listType: z.enum(['personal', 'household']).default('personal'),
    ...base,
  }),
  z.object({
    type: z.literal('log_weight'),
    value: z.number().min(20).max(400),
    unit: z.literal('kg').default('kg'),
    dateLocal: localDate.default(null),
    ...base,
  }),
  z.object({
    type: z.literal('log_steps'),
    value: z.number().int().min(0).max(150000),
    dateLocal: localDate.default(null),
    ...base,
  }),
  z.object({
    type: z.literal('log_meal'),
    slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack']),
    description: z.string().max(500).default(''),
    dateLocal: localDate.default(null),
    ...base,
  }),
  z.object({
    type: z.literal('schedule_workout'),
    title: z.string().min(1).max(200).default('Тренировка'),
    dateLocal: localDate.default(null),
    timeLocal: localTime.default(null),
    ...base,
  }),
  z.object({
    type: z.literal('extra_work'),
    durationMinutes: z.number().int().min(15).max(480),
    dateLocal: localDate.default(null),
    ...base,
  }),
  z.object({
    type: z.literal('idea'),
    title: z.string().min(1).max(300),
    category: z.enum(['idea', 'wish', 'own_project']).default('idea'),
    ...base,
  }),
  z.object({
    type: z.literal('note'),
    text: z.string().min(1).max(2000),
    ...base,
  }),
]);

export type ProposedAction = z.infer<typeof proposedActionSchema>;

export const parseResultSchema = z.object({
  language: z.enum(['ru', 'uk', 'en', 'mixed', 'unknown']).default('unknown'),
  actions: z.array(proposedActionSchema).max(20),
});

export type ParseResult = z.infer<typeof parseResultSchema>;

/** Actions that may be auto-applied without confirmation when the user enabled that mode. */
export function isLowRisk(a: ProposedAction): boolean {
  return (a.type === 'add_shopping_item' || a.type === 'note' || a.type === 'idea') && !a.needsConfirmation;
}

export const ACTION_LABELS: Record<ProposedAction['type'], string> = {
  create_task: 'Задача',
  create_waiting: 'Ожидание ответа',
  add_shopping_item: 'Покупка',
  log_weight: 'Вес',
  log_steps: 'Шаги',
  log_meal: 'Еда',
  schedule_workout: 'Тренировка',
  extra_work: 'Дополнительная работа',
  idea: 'Идея',
  note: 'Заметка во входящие',
};
