import { AppError, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { isLocalDate, localDateOf, weekStartOf } from '@/domain/time';
import { habitPatchSchema, habitsWeek, setHabitEnabled } from '@/server/services/habits';

/** Habit definitions + check-ins of a week (default: the current one). */
export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const week = url.searchParams.get('week') ?? localDateOf(now(), ctx.tz);
    if (!isLocalDate(week)) throw new AppError('BAD_DATE', 'week: YYYY-MM-DD', 400);
    return habitsWeek(tx, ctx.userId, weekStartOf(week));
  }),
);

/** Enable/disable a habit or change its target — every rule can be switched off (PRD §7.2). */
export const PATCH = userRoute(async ({ req, user }) => {
  const input = await readJson(req, habitPatchSchema);
  return inUser(user.id, async (tx, ctx) => {
    await setHabitEnabled(tx, ctx.userId, input.habitId, input.enabled, input.target);
    return { ok: true };
  });
});
