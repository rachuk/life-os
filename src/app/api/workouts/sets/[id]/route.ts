import { param, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { deleteSet } from '@/server/services/workouts';

export const DELETE = userRoute(async ({ user, params }) =>
  inUser(user.id, async (tx, ctx) => {
    await deleteSet(tx, ctx.userId, param(params, 'id'));
    return { ok: true };
  }),
);
