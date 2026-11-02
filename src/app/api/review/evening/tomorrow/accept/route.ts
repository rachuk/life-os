import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { acceptTomorrow, acceptTomorrowSchema } from '@/server/services/review';

/** «Принять всё» (or one edited item with confirmDay=false). Idempotent for repeated taps. */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, acceptTomorrowSchema);
  return inUser(user.id, (tx, ctx) => acceptTomorrow(tx, ctx, now(), input));
});
