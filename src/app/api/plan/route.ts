import { AppError, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { isLocalDate, localDateOf, weekStartOf } from '@/domain/time';
import { getWeekData } from '@/server/views/plan';

export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const from = url.searchParams.get('from') ?? weekStartOf(localDateOf(now(), ctx.tz));
    if (!isLocalDate(from)) throw new AppError('BAD_DATE', 'from: YYYY-MM-DD', 400);
    return getWeekData(tx, ctx, now(), weekStartOf(from));
  }),
);
