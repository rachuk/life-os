import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { z } from 'zod';
import { now } from '@/server/context';
import { createTask, listTasks, parseTitleDates, serializeTask, taskInputSchema, taskTabCounts, type TaskTab } from '@/server/services/tasks';

const TABS = new Set(['inbox', 'scheduled', 'waiting', 'someday', 'done', 'all']);

export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const tab = (TABS.has(url.searchParams.get('tab') ?? '') ? url.searchParams.get('tab') : 'inbox') as TaskTab;
    const tasks = await listTasks(tx, ctx, tab, url.searchParams.get('q'));
    return { tasks: tasks.map(serializeTask), counts: await taskTabCounts(tx, user.id) };
  }),
);

const postSchema = taskInputSchema.extend({ parseDates: z.boolean().optional() });

export const POST = userRoute(async ({ req, user }) => {
  const { parseDates, ...input } = await readJson(req, postSchema);
  return inUser(user.id, async (tx, ctx) => {
    let note: string | null = null;
    if (parseDates && !input.dueDate) {
      const p = parseTitleDates(input.title, now(), ctx.tz);
      input.title = p.title;
      input.dueDate = p.dueDate;
      input.dueTime = p.dueTime;
      note = p.note;
    }
    return { task: serializeTask(await createTask(tx, ctx, input, { source: 'manual' })), note };
  });
});
