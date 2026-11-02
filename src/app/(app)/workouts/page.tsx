import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { workoutOverview } from '@/server/services/workouts';
import { WorkoutsClient } from '@/components/workouts/WorkoutsClient';

export const metadata = { title: 'Тренировки' };

export default async function WorkoutsPage({ searchParams }: { searchParams: Promise<{ event?: string }> }) {
  const user = await requirePageUser();
  const { event } = await searchParams;
  const o = await inUser(user.id, (tx, ctx) => workoutOverview(tx, ctx, now(), { eventId: event ?? null }));
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Тренировки</h1>
        <p className="text-sm text-muted">{o.plan.name} · цель {o.progress.target} в неделю. Регулярность важнее рекордов.</p>
      </header>
      <WorkoutsClient o={o} />
    </div>
  );
}
