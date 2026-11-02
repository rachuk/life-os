import { param, readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { addCheckpoint, checkpointSchema } from '@/server/services/skills';

export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, checkpointSchema);
  return inUser(user.id, (tx, ctx) => addCheckpoint(tx, ctx, param(params, 'id'), input));
});
