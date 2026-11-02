import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { setInputSchema, upsertSet } from '@/server/services/workouts';

/** Add a set, or update one when setId is given. */
export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, setInputSchema);
  return inUser(user.id, async (tx, ctx) => ({ set: await upsertSet(tx, ctx, now(), param(params, 'id'), input) }));
});
