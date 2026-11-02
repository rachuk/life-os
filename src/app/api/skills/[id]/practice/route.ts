import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { logPractice, practiceSchema } from '@/server/services/skills';

export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, practiceSchema);
  return inUser(user.id, (tx, ctx) => logPractice(tx, ctx, now(), param(params, 'id'), input));
});
