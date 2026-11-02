import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { quickLog, quickLogSchema } from '@/server/services/workouts';

/** «Тренировка состоялась» + duration, without sets — counts toward the weekly target. */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, quickLogSchema);
  return inUser(user.id, (tx, ctx) => quickLog(tx, ctx, now(), input));
});
