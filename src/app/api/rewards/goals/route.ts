import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { createGoal, goalInputSchema } from '@/server/services/rewards';

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, goalInputSchema);
  return inUser(user.id, async (tx) => ({ goal: await createGoal(tx, user.id, input) }));
});
