import { z } from 'zod';
import { notFound, param, readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { isUuid } from '@/server/db';
import { serializeShoppingItem, setItemChecked } from '@/server/services/shopping';

const body = z.object({ checked: z.boolean() });

/** Mark bought / not bought. "Bought" does not mean it is in stock all week (PRD §9.4). */
export const POST = userRoute(async ({ req, user, params }) => {
  const id = param(params, 'id');
  if (!isUuid(id)) throw notFound('Покупка');
  const { checked } = await readJson(req, body);
  return inUser(user.id, async (tx, ctx) => ({ item: serializeShoppingItem(await setItemChecked(tx, ctx.userId, id, checked)) }));
});
