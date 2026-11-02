import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { logHabitEvent, logSchema } from '@/server/services/habitChange';

/** «+1» or «Удержался» — one tap; the reason can be added right after. */
export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, logSchema);
  return inUser(user.id, async (tx, ctx) => {
    const r = await logHabitEvent(tx, ctx, now(), param(params, 'id'), input, 'web');
    return { id: r.id, todayTotal: r.todayTotal, limit: r.limit };
  });
});
