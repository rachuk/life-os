import { AppError, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { tomorrowDraft } from '@/server/services/review';

/** Draft for a day: events + suggestions with sources and proposed slots. Read-only for the plan. */
export const GET = userRoute(async ({ user, url }) => {
  const date = url.searchParams.get('date');
  if (!date) throw new AppError('BAD_REQUEST', 'Укажи дату', 400);
  return inUser(user.id, (tx, ctx) => tomorrowDraft(tx, ctx, now(), date));
});
