import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { decideProgression, progressionDecisionSchema } from '@/server/services/workouts';

/** «Принять» / «Не сейчас» for a progression suggestion — it is never applied automatically. */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, progressionDecisionSchema);
  return inUser(user.id, async (tx, ctx) => {
    await decideProgression(tx, ctx.userId, input);
    return { ok: true };
  });
});
