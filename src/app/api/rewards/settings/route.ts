import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { rewardsSettingsPatchSchema, updateRewardsSettings } from '@/server/services/rewards';

export const PATCH = userRoute(async ({ req, user }) => {
  const input = await readJson(req, rewardsSettingsPatchSchema);
  return inUser(user.id, async (tx) => ({ settings: await updateRewardsSettings(tx, user.id, input) }));
});
