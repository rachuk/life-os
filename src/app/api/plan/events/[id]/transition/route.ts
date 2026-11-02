import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { transitionEvent, transitionSchema } from '@/server/services/planning';

/** Start / complete / skip / snooze / reschedule with reason (PRD §5.2). */
export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, transitionSchema);
  return inUser(user.id, (tx, ctx) => transitionEvent(tx, ctx, now(), param(params, 'id'), input, 'web'));
});
