import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { extraWorkCommit, extraWorkCommitSchema } from '@/server/services/planning';

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, extraWorkCommitSchema);
  return inUser(user.id, (tx, ctx) => extraWorkCommit(tx, ctx, now(), input));
});
