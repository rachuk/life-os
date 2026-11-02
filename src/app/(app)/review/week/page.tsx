import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { weekHabitFacts } from '@/server/services/habitChange';
import { weekSkillFacts } from '@/server/services/skills';
import { defaultReviewWeek, getWeeklyReview, resolveWeekStart } from '@/server/services/weeklyReview';
import { WeekChangeBlock } from '@/components/review/WeekChangeBlock';
import { WeeklyReviewClient } from '@/components/review/WeeklyReviewClient';

export const metadata = { title: 'Обзор недели' };

export default async function WeeklyReviewPage({ searchParams }: { searchParams: Promise<{ week?: string }> }) {
  const user = await requirePageUser();
  const { week } = await searchParams;
  const { view, habits, skills } = await inUser(user.id, async (tx, ctx) => {
    const t = now();
    const ws = week ? resolveWeekStart(week, ctx, t) : defaultReviewWeek(ctx, t);
    return { view: await getWeeklyReview(tx, ctx, t, ws), habits: await weekHabitFacts(tx, ctx, ws), skills: await weekSkillFacts(tx, ctx, ws) };
  });
  return (
    <>
      <WeeklyReviewClient view={view} />
      <WeekChangeBlock habits={habits} skills={skills} />
    </>
  );
}
