import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { startSession, startSessionSchema } from '@/server/services/workouts';

/** Start A / B / «всё тело», optionally linked to a planned workout event (event → started). */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, startSessionSchema);
  return inUser(user.id, (tx, ctx) => startSession(tx, ctx, now(), input));
});
