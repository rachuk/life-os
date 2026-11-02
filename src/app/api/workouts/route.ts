import { userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { workoutOverview } from '@/server/services/workouts';

/** Everything the workouts screen needs: plan, week target, active session, previous sets, suggestions. */
export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, (tx, ctx) => workoutOverview(tx, ctx, now(), { eventId: url.searchParams.get('event') })),
);
