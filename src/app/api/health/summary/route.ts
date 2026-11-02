import { AppError, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { addDays, isLocalDate, localDateOf } from '@/domain/time';
import { healthSummary } from '@/server/services/health';

/** Day-by-day series with explicit nulls (HEALTH-05) + 7-day weight trend when there are enough points. */
export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const today = localDateOf(now(), ctx.tz);
    const to = url.searchParams.get('to') ?? today;
    const from = url.searchParams.get('from') ?? addDays(to, -29);
    if (!isLocalDate(from) || !isLocalDate(to)) throw new AppError('BAD_DATE', 'from/to: YYYY-MM-DD', 400);
    return healthSummary(tx, ctx.userId, from, to);
  }),
);
