import { z } from 'zod';
import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { skipEveningReview } from '@/server/services/review';

/** «Пропустить обзор сегодня» — nothing else changes, tomorrow's plan stays as it is. */
export const POST = userRoute(async ({ req, user }) => {
  const { date } = await readJson(req, z.object({ date: z.string().max(10) }));
  return inUser(user.id, (tx, ctx) => skipEveningReview(tx, ctx, now(), date));
});
