import { userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { defaultReviewWeek, getWeeklyReview, resolveWeekStart } from '@/server/services/weeklyReview';

/** Stored weekly review for ?week=YYYY-MM-DD (any day of the week); null review = not generated yet. */
export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, (tx, ctx) => {
    const t = now();
    const q = url.searchParams.get('week');
    return getWeeklyReview(tx, ctx, t, q ? resolveWeekStart(q, ctx, t) : defaultReviewWeek(ctx, t));
  }),
);
