import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { skillsOverview } from '@/server/services/skills';
import { SkillsClient } from '@/components/skills/SkillsClient';

export const metadata = { title: 'Навыки' };

export default async function SkillsPage() {
  const user = await requirePageUser();
  const data = await inUser(user.id, (tx, ctx) => skillsOverview(tx, ctx, now()));
  return <SkillsClient data={JSON.parse(JSON.stringify(data))} />;
}
