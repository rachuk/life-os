import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { eveningView } from '@/server/services/review';
import { EveningReviewClient } from '@/components/review/EveningReviewClient';

export const metadata = { title: 'Вечерний обзор' };

export default async function EveningReviewPage({ searchParams }: { searchParams: Promise<{ date?: string }> }) {
  const user = await requirePageUser();
  const { date } = await searchParams;
  const view = await inUser(user.id, (tx, ctx) => eveningView(tx, ctx, now(), date ?? null));
  return <EveningReviewClient view={view} />;
}
