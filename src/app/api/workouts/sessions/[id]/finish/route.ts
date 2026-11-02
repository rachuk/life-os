import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { finishSchema, finishSession } from '@/server/services/workouts';

/** Finish: duration, perceived effort 1–10, notes → session completed + linked event completed. */
export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, finishSchema);
  return inUser(user.id, (tx, ctx) => finishSession(tx, ctx, now(), param(params, 'id'), input));
});
