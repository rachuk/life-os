import { userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { sessionHistory } from '@/server/services/workouts';

export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const limit = Number(url.searchParams.get('limit') ?? 20);
    return { sessions: await sessionHistory(tx, ctx.userId, Number.isFinite(limit) ? limit : 20) };
  }),
);
