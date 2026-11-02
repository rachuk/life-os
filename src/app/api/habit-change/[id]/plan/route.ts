import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { startPlan, startPlanSchema } from '@/server/services/habitChange';

export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, startPlanSchema);
  return inUser(user.id, async (tx, ctx) => ({ program: await startPlan(tx, ctx, now(), param(params, 'id'), input) }));
});
