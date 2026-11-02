import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { rewardsSummary } from '@/server/services/rewards';
import { RewardsClient } from '@/components/rewards/RewardsClient';

export const metadata = { title: 'Награды' };

export default async function RewardsPage() {
  const user = await requirePageUser();
  const data = await inUser(user.id, (tx, ctx) => rewardsSummary(tx, ctx, now()));
  return <RewardsClient data={data} />;
}
