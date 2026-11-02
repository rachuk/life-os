import { AppError, param, readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { isUuid } from '@/server/db';
import { deleteMealTemplate, mealTemplatePatchSchema, patchMealTemplate } from '@/server/services/meals';

function templateId(params: Record<string, string | string[] | undefined>) {
  const id = param(params, 'id');
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Шаблон не найден', 404);
  return id;
}

/** Edit or enable/disable; toggling keeps the «пример» flag, editing makes it the user's own. */
export const PATCH = userRoute(async ({ req, user, params }) => {
  const id = templateId(params);
  const patch = await readJson(req, mealTemplatePatchSchema);
  return inUser(user.id, async (tx, ctx) => ({ id: await patchMealTemplate(tx, ctx.userId, id, patch) }));
});

export const DELETE = userRoute(async ({ user, params }) => {
  const id = templateId(params);
  return inUser(user.id, async (tx, ctx) => {
    await deleteMealTemplate(tx, ctx.userId, id);
    return { ok: true };
  });
});
