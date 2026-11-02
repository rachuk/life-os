import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { listPrograms, programOverview } from '@/server/services/habitChange';
import { HabitChangeClient } from '@/components/habitChange/HabitChangeClient';

export const metadata = { title: 'Изменение привычек' };

export default async function HabitsPage() {
  const user = await requirePageUser();
  const programs = await inUser(user.id, async (tx, ctx) => {
    const list = await listPrograms(tx, user.id);
    return Promise.all(list.map((p) => programOverview(tx, ctx, now(), p.id)));
  });
  return <HabitChangeClient programs={JSON.parse(JSON.stringify(programs))} />;
}
