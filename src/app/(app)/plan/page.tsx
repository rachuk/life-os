import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { getWeekData } from '@/server/views/plan';
import { isLocalDate, localDateOf, weekStartOf } from '@/domain/time';
import { PlanClient } from '@/components/plan/PlanClient';

export const metadata = { title: 'План' };

export default async function PlanPage({ searchParams }: { searchParams: Promise<{ week?: string; date?: string; view?: string }> }) {
  const user = await requirePageUser();
  const sp = await searchParams;
  const data = await inUser(user.id, async (tx, ctx) => {
    const today = localDateOf(now(), ctx.tz);
    const date = sp.date && isLocalDate(sp.date) ? sp.date : today;
    const week = sp.week && isLocalDate(sp.week) ? weekStartOf(sp.week) : weekStartOf(date);
    return { week: await getWeekData(tx, ctx, now(), week), today, date: weekStartOf(date) === week ? date : week };
  });
  return <PlanClient data={data.week} today={data.today} initialDate={data.date} initialView={sp.view === 'week' ? 'week' : 'day'} />;
}
