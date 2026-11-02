import { param, readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { goalPatchSchema, updateGoal } from '@/server/services/rewards';

export const PATCH = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, goalPatchSchema);
  return inUser(user.id, async (tx) => ({ goal: await updateGoal(tx, user.id, param(params, 'id'), input) }));
});
