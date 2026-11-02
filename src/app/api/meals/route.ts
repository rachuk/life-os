import { AppError, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { addDays, daysBetween, isLocalDate, localDateOf, weekStartOf } from '@/domain/time';
import { mealsRange } from '@/server/services/meals';

/** Meal logs + planned dishes + templates for a range (default: the current week). */
export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const ws = weekStartOf(localDateOf(now(), ctx.tz));
    const from = url.searchParams.get('from') ?? ws;
    const to = url.searchParams.get('to') ?? addDays(ws, 6);
    if (!isLocalDate(from) || !isLocalDate(to) || from > to) throw new AppError('BAD_DATE', 'from/to: YYYY-MM-DD', 400);
    if (daysBetween(from, to) > 62) throw new AppError('RANGE_TOO_LONG', 'Не больше двух месяцев за раз', 400);
    return mealsRange(tx, ctx.userId, from, to);
  }),
);
