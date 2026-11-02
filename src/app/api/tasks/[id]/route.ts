import { param, readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { deleteTask, serializeTask, taskPatchSchema, updateTask } from '@/server/services/tasks';

export const PATCH = userRoute(async ({ req, user, params }) => {
  const patch = await readJson(req, taskPatchSchema);
  return inUser(user.id, async (tx, ctx) => ({ task: serializeTask(await updateTask(tx, ctx, param(params, 'id'), patch)) }));
});

export const DELETE = userRoute(async ({ user, params }) =>
  inUser(user.id, async (tx, ctx) => {
    await deleteTask(tx, ctx, param(params, 'id'));
    return { ok: true };
  }),
);
