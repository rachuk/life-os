import { param, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { cancelSession } from '@/server/services/workouts';

/** Cancel a session started by mistake (nothing is counted; a started event goes back to planned). */
export const POST = userRoute(async ({ user, params }) =>
  inUser(user.id, async (tx, ctx) => {
    await cancelSession(tx, ctx, now(), param(params, 'id'));
    return { ok: true };
  }),
);
