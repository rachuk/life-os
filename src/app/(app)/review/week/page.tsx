import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { defaultReviewWeek, getWeeklyReview, resolveWeekStart } from '@/server/services/weeklyReview';
import { WeeklyReviewClient } from '@/components/review/WeeklyReviewClient';

export const metadata = { title: 'Обзор недели' };

export default async function WeeklyReviewPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requirePageUser();
  const { week } = await searchParams;
  const view = await inUser(user.id, (tx, ctx) => {
    const t = now();
    return getWeeklyReview(tx, ctx, t, week ? resolveWeekStart(week, ctx, t) : defaultReviewWeek(ctx, t));
  });
  return <WeeklyReviewClient view={view} />;
}
