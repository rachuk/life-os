import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { createTask, listTasks, serializeTask, taskCounts, taskInputSchema, type TaskTab } from '@/server/services/tasks';

const TABS = new Set(['inbox', 'scheduled', 'waiting', 'someday', 'done', 'all']);

export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const tab = (TABS.has(url.searchParams.get('tab') ?? '') ? url.searchParams.get('tab') : 'inbox') as TaskTab;
    const tasks = await listTasks(tx, ctx, tab, url.searchParams.get('q'));
    return { tasks: tasks.map(serializeTask), counts: await taskCounts(tx, user.id) };
  }),
);

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, taskInputSchema);
  return inUser(user.id, async (tx, ctx) => ({ task: serializeTask(await createTask(tx, ctx, input, { source: 'manual' })) }));
});
