import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { checkpointResultSchema, completeCheckpoint } from '@/server/services/skills';

/** The only way a skill level changes: a checkpoint result. */
export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, checkpointResultSchema);
  return inUser(user.id, (tx, ctx) => completeCheckpoint(tx, ctx, now(), param(params, 'id'), input));
});
