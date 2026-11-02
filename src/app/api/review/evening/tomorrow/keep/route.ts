import { z } from 'zod';
import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { keepTomorrow } from '@/server/services/review';

/** «Оставить без изменений»: the existing plan for the day stays, nothing is moved. */
export const POST = userRoute(async ({ req, user }) => {
  const { date } = await readJson(req, z.object({ date: z.string().max(10) }));
  return inUser(user.id, (tx, ctx) => keepTomorrow(tx, ctx, now(), date));
});
