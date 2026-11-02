import { userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { getTodayData } from '@/server/views/today';

export const GET = userRoute(async ({ user, url }) => inUser(user.id, (tx, ctx) => getTodayData(tx, ctx, now(), url.searchParams.get('date'))));
