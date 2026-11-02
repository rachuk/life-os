import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { createGoal, goalInputSchema, rewardsSummary } from '@/server/services/rewards';

/** Summary: XP/level/achievements, wish goals, ledger, budget usage (GET); new wish goal (POST). */
export const GET = userRoute(async ({ user }) => inUser(user.id, (tx, ctx) => rewardsSummary(tx, ctx, now())));

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, goalInputSchema);
  return inUser(user.id, async (tx) => ({ goal: await createGoal(tx, user.id, input) }));
});
