import { param, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { deletePractice } from '@/server/services/skills';

export const DELETE = userRoute(async ({ user, params }) =>
  inUser(user.id, async (tx) => {
    await deletePractice(tx, user.id, param(params, 'id'));
    return { ok: true };
  }),
);
