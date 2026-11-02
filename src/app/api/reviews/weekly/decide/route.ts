import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { decideSchema, decideWeeklyReview } from '@/server/services/weeklyReview';

/** Accept/reject proposals; accepted ones are applied atomically in this one transaction. Idempotent. */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, decideSchema);
  return inUser(user.id, (tx, ctx) => decideWeeklyReview(tx, ctx, now(), input));
});
