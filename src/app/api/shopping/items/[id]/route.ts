import { notFound, param, readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { isUuid } from '@/server/db';
import { deleteItem, itemPatchSchema, serializeShoppingItem, updateItem } from '@/server/services/shopping';

function itemId(params: Record<string, string | string[] | undefined>) {
  const id = param(params, 'id');
  if (!isUuid(id)) throw notFound('Покупка');
  return id;
}

/** Edit name / quantity / unit / note. */
export const PATCH = userRoute(async ({ req, user, params }) => {
  const id = itemId(params);
  const patch = await readJson(req, itemPatchSchema);
  return inUser(user.id, async (tx, ctx) => ({ item: serializeShoppingItem(await updateItem(tx, ctx.userId, id, patch)) }));
});

export const DELETE = userRoute(async ({ user, params }) => {
  const id = itemId(params);
  return inUser(user.id, async (tx, ctx) => {
    await deleteItem(tx, ctx.userId, id);
    return { ok: true };
  });
});
