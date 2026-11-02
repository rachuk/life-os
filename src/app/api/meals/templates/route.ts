import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { listMealTemplates, mealTemplateSchema, upsertMealTemplate } from '@/server/services/meals';

export const GET = userRoute(async ({ user }) => inUser(user.id, async (tx, ctx) => ({ templates: await listMealTemplates(tx, ctx.userId) })));

/** Own template with ingredients (no calories — PRD §8.3). */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, mealTemplateSchema);
  return inUser(user.id, async (tx, ctx) => ({ id: await upsertMealTemplate(tx, ctx.userId, null, input) }));
});
