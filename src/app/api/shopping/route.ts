import { z } from 'zod';
import { AppError, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { isLocalDate, localDateOf } from '@/domain/time';
import { addItemSchema, addShoppingItem, addShoppingText, addTextSchema, serializeShoppingItem, weekShopping } from '@/server/services/shopping';

/** Both baskets of a week with items and the ready-to-copy text. */
export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const week = url.searchParams.get('week') ?? localDateOf(now(), ctx.tz);
    if (!isLocalDate(week)) throw new AppError('BAD_DATE', 'week: YYYY-MM-DD', 400);
    return weekShopping(tx, ctx.userId, week);
  }),
);

const addBody = z.union([addTextSchema, addItemSchema]);

/**
 * Add an item: either free text ("молоко 2 л") or structured name/quantity/unit. Dedupe/merge rules
 * (HEALTH-08): the same product is not added twice, compatible units merge, different products never.
 */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, addBody);
  return inUser(user.id, async (tx, ctx) => {
    const r = 'text' in input ? await addShoppingText(tx, ctx, now(), input) : await addShoppingItem(tx, ctx, now(), input, 'manual');
    return { item: serializeShoppingItem(r.item), outcome: r.outcome, message: r.message };
  });
});
