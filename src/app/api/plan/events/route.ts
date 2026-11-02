import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { createEventSchema, createManualEvent } from '@/server/services/planning';

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, createEventSchema);
  return inUser(user.id, (tx, ctx) => createManualEvent(tx, ctx, now(), input));
});
