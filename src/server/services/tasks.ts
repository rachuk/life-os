import { DateTime } from 'luxon';
import { z } from 'zod';
import { TASK_CATEGORIES } from '@/domain/capture/schema';
import { isLocalDate, isLocalTime, zoned } from '@/domain/time';
import { one, type Tx } from '../db';
import { AppError, notFound } from '../http';
import { audit } from './audit';
import type { UserContext } from './profile';

export interface TaskRow {
  id: string;
  projectId: string | null;
  title: string;
  details: string | null;
  type: string;
  category: string;
  status: string;
  priority: string;
  dueAt: Date | null;
  dueDate: string | null;
  plannedAt: Date | null;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  nextAction: string | null;
  waitingFor: string | null;
  followUpAt: Date | null;
  source: string;
  privacyClass: string;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export function serializeTask(t: TaskRow) {
  return {
    ...t,
    dueAt: t.dueAt?.toISOString() ?? null,
    plannedAt: t.plannedAt?.toISOString() ?? null,
    followUpAt: t.followUpAt?.toISOString() ?? null,
    completedAt: t.completedAt?.toISOString() ?? null,
    createdAt: t.createdAt.toISOString(),
    updatedAt: t.updatedAt.toISOString(),
  };
}
export type SerializedTask = ReturnType<typeof serializeTask>;

const date = z.string().refine(isLocalDate, 'Дата YYYY-MM-DD');
const time = z.string().refine(isLocalTime, 'Время ЧЧ:ММ');

export const taskInputSchema = z.object({
  title: z.string().trim().min(1, 'Название обязательно').max(500),
  details: z.string().trim().max(5000).nullable().optional(),
  type: z.enum(['task', 'reminder', 'waiting', 'idea', 'wish', 'event']).default('task'),
  category: z.enum(TASK_CATEGORIES).default('personal'),
  status: z.enum(['inbox', 'todo', 'scheduled', 'in_progress', 'waiting', 'someday', 'done', 'cancelled']).optional(),
  priority: z.enum(['low', 'normal', 'high']).default('normal'),
  dueDate: date.nullable().optional(),
  dueTime: time.nullable().optional(),
  estimatedMinutes: z.number().int().min(1).max(1440).nullable().optional(),
  nextAction: z.string().trim().max(300).nullable().optional(),
  waitingFor: z.string().trim().max(200).nullable().optional(),
  followUpDate: date.nullable().optional(),
  projectId: z.string().uuid().nullable().optional(),
  privacyClass: z.enum(['normal', 'work_neutral', 'sensitive']).optional(),
});
export type TaskInput = z.infer<typeof taskInputSchema>;
export const taskPatchSchema = taskInputSchema.partial();

function deriveStatus(i: Partial<TaskInput>): string {
  if (i.status) return i.status;
  if (i.type === 'waiting') return 'waiting';
  if (i.type === 'idea' || i.type === 'wish') return 'someday';
  if (i.dueDate) return 'todo';
  return 'inbox';
}

export async function createTask(
  tx: Tx,
  ctx: UserContext,
  input: TaskInput,
  meta: { source?: string; sourceMessageId?: string | null; inboxItemId?: string | null } = {},
): Promise<TaskRow> {
  const dueAt = input.dueDate && input.dueTime ? zoned(input.dueDate, input.dueTime, ctx.tz).toJSDate() : null;
  const followUpAt = input.followUpDate ? zoned(input.followUpDate, '10:00', ctx.tz).toJSDate() : null;
  const privacy = input.privacyClass ?? (input.category === 'work_reminder' ? 'work_neutral' : 'normal');
  const row = one(
    await tx<TaskRow[]>`
      insert into tasks (user_id, project_id, title, details, type, category, status, priority, due_at, due_date,
                         estimated_minutes, next_action, waiting_for, follow_up_at, source, source_message_id, inbox_item_id, privacy_class)
      values (${ctx.userId}, ${input.projectId ?? null}, ${input.title}, ${input.details ?? null}, ${input.type}, ${input.category},
              ${deriveStatus(input)}, ${input.priority}, ${dueAt}, ${input.dueDate ?? null}, ${input.estimatedMinutes ?? null},
              ${input.nextAction ?? null}, ${input.waitingFor ?? null}, ${followUpAt}, ${meta.source ?? 'manual'},
              ${meta.sourceMessageId ?? null}, ${meta.inboxItemId ?? null}, ${privacy})
      returning *`,
  );
  await audit(tx, ctx.userId, 'task', row.id, 'created', { type: row.type, category: row.category }, meta.source ?? 'web');
  return row;
}

export async function updateTask(tx: Tx, ctx: UserContext, id: string, patch: z.infer<typeof taskPatchSchema>): Promise<TaskRow> {
  const [cur] = await tx<TaskRow[]>`select * from tasks where id = ${id} and user_id = ${ctx.userId}`;
  if (!cur) throw notFound('Задача');
  const dueDate = patch.dueDate !== undefined ? patch.dueDate : cur.dueDate;
  const dueTime = patch.dueTime !== undefined ? patch.dueTime : cur.dueAt ? DateTime.fromJSDate(cur.dueAt).setZone(ctx.tz).toFormat('HH:mm') : null;
  const dueAt = dueDate && dueTime ? zoned(dueDate, dueTime, ctx.tz).toJSDate() : null;
  const followUpAt =
    patch.followUpDate !== undefined ? (patch.followUpDate ? zoned(patch.followUpDate, '10:00', ctx.tz).toJSDate() : null) : cur.followUpAt;
  const status = patch.status ?? (patch.type && patch.type !== cur.type ? deriveStatus({ ...patch, dueDate }) : cur.status);
  const completedAt = status === 'done' ? (cur.completedAt ?? new Date()) : null;
  const row = one(
    await tx<TaskRow[]>`
      update tasks set
        title = ${patch.title ?? cur.title}, details = ${patch.details !== undefined ? patch.details : cur.details},
        type = ${patch.type ?? cur.type}, category = ${patch.category ?? cur.category}, status = ${status},
        priority = ${patch.priority ?? cur.priority}, due_date = ${dueDate}, due_at = ${dueAt},
        estimated_minutes = ${patch.estimatedMinutes !== undefined ? patch.estimatedMinutes : cur.estimatedMinutes},
        next_action = ${patch.nextAction !== undefined ? patch.nextAction : cur.nextAction},
        waiting_for = ${patch.waitingFor !== undefined ? patch.waitingFor : cur.waitingFor},
        follow_up_at = ${followUpAt}, project_id = ${patch.projectId !== undefined ? patch.projectId : cur.projectId},
        privacy_class = ${patch.privacyClass ?? cur.privacyClass}, completed_at = ${completedAt}
      where id = ${id} and user_id = ${ctx.userId} returning *`,
  );
  await audit(tx, ctx.userId, 'task', id, 'updated', { fields: Object.keys(patch), status }, 'web');
  return row;
}

export type TaskTab = 'inbox' | 'scheduled' | 'waiting' | 'someday' | 'done' | 'all';

export async function listTasks(tx: Tx, ctx: UserContext, tab: TaskTab, q?: string | null): Promise<TaskRow[]> {
  const search = q?.trim() ? `%${q.trim().replace(/[%_]/g, '')}%` : null;
  const statuses: Record<TaskTab, string[]> = {
    inbox: ['inbox', 'todo', 'in_progress'],
    scheduled: ['scheduled'],
    waiting: ['waiting'],
    someday: ['someday'],
    done: ['done', 'cancelled'],
    all: ['inbox', 'todo', 'scheduled', 'in_progress', 'waiting', 'someday', 'done', 'cancelled'],
  };
  return tx<TaskRow[]>`
    select * from tasks
    where user_id = ${ctx.userId} and status = any(${statuses[tab]})
      and (${search}::text is null or title ilike ${search} or coalesce(details, '') ilike ${search})
    order by
      case when ${tab} = 'done' then extract(epoch from coalesce(completed_at, updated_at)) * -1 else 0 end,
      due_date nulls last, follow_up_at nulls last, priority = 'high' desc, created_at desc
    limit 300`;
}

export async function taskCounts(tx: Tx, userId: string): Promise<Record<string, number>> {
  const rows = await tx<{ status: string; n: number }[]>`
    select status, count(*)::int as n from tasks where user_id = ${userId} group by status`;
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/** TASK-04: complete a task and optionally create the follow-up "проверить ответ". */
export async function completeTask(
  tx: Tx,
  ctx: UserContext,
  id: string,
  opts: { followUp?: { title: string; date: string; waitingFor?: string | null } | null } = {},
): Promise<{ task: TaskRow; followUp: TaskRow | null }> {
  const task = await updateTask(tx, ctx, id, { status: 'done' });
  let followUp: TaskRow | null = null;
  if (opts.followUp) {
    if (!isLocalDate(opts.followUp.date)) throw new AppError('BAD_DATE', 'Некорректная дата проверки', 422);
    followUp = await createTask(tx, ctx, {
      title: opts.followUp.title,
      type: 'waiting',
      category: task.category as TaskInput['category'],
      priority: 'normal',
      waitingFor: opts.followUp.waitingFor ?? null,
      followUpDate: opts.followUp.date,
      projectId: task.projectId,
    });
  }
  return { task, followUp };
}

export async function deleteTask(tx: Tx, ctx: UserContext, id: string): Promise<void> {
  const rows = await tx`delete from tasks where id = ${id} and user_id = ${ctx.userId} returning id`;
  if (!rows.length) throw notFound('Задача');
  await audit(tx, ctx.userId, 'task', id, 'deleted', {}, 'web');
}

// projects
export const projectInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.enum(TASK_CATEGORIES).default('own_project'),
  status: z.enum(['active', 'paused', 'done', 'archived']).default('active'),
  notes: z.string().max(5000).nullable().optional(),
  targetMinutesPerWeek: z.number().int().min(0).max(5000).nullable().optional(),
});

export async function listProjects(tx: Tx, userId: string) {
  return tx<{ id: string; name: string; category: string; status: string; notes: string | null; targetMinutesPerWeek: number | null; openTasks: number }[]>`
    select p.id, p.name, p.category, p.status, p.notes, p.target_minutes_per_week,
      (select count(*)::int from tasks t where t.project_id = p.id and t.status not in ('done','cancelled')) as open_tasks
    from projects p where p.user_id = ${userId} and p.status <> 'archived' order by p.created_at`;
}

export async function createProject(tx: Tx, userId: string, input: z.infer<typeof projectInputSchema>) {
  return one(
    await tx<{ id: string; name: string }[]>`
      insert into projects (user_id, name, category, status, notes, target_minutes_per_week)
      values (${userId}, ${input.name}, ${input.category}, ${input.status}, ${input.notes ?? null}, ${input.targetMinutesPerWeek ?? null})
      returning id, name`,
  );
}
