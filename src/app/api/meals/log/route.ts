import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { logMeal, mealLogSchema } from '@/server/services/meals';

/** The explicit "Съел всё / Часть / Заменил / Не ел" answer — the only way a meal becomes eaten. */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, mealLogSchema);
  return inUser(user.id, async (tx, ctx) => {
    const row = await logMeal(tx, ctx, now(), input, 'web');
    return { log: { ...row, eatenAt: row.eatenAt.toISOString() } };
  });
});
