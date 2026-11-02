import { userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { listPlans } from '@/server/services/workouts';

export const GET = userRoute(async ({ user }) => inUser(user.id, async (tx, ctx) => ({ plans: await listPlans(tx, ctx) })));
