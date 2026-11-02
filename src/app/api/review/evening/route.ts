import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { eveningReviewSchema, eveningView, saveEveningReview } from '@/server/services/review';

/** Evening review: facts of the day + tomorrow draft (GET), save the 2–4 answers (POST). */
export const GET = userRoute(async ({ user, url }) => inUser(user.id, (tx, ctx) => eveningView(tx, ctx, now(), url.searchParams.get('date'))));

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, eveningReviewSchema);
  return inUser(user.id, (tx, ctx) => saveEveningReview(tx, ctx, now(), input));
});
