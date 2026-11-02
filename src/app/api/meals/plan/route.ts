import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { mealPlanSchema, planMeal } from '@/server/services/meals';

/** Set (or clear) the planned dish for a date + slot. Planning never marks a meal eaten. */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, mealPlanSchema);
  return inUser(user.id, async (tx, ctx) => {
    await planMeal(tx, ctx.userId, input);
    return { ok: true };
  });
});
