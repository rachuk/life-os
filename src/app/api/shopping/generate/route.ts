import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { addFromMealTemplates, generateSchema } from '@/server/services/shopping';

/** «Собрать из меню»: templates × times → week lists; idempotent (repeating never duplicates). */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, generateSchema);
  return inUser(user.id, (tx, ctx) => addFromMealTemplates(tx, ctx, now(), input.weekStart, input.picks));
});
