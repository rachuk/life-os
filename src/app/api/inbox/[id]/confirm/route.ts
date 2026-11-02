import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { confirmInboxItem, confirmSchema, serializeInboxItem } from '@/server/services/inbox';

export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, confirmSchema);
  const r = await inUser(user.id, (tx, ctx) => confirmInboxItem(tx, ctx, now(), param(params, 'id'), input));
  return { ...r, item: serializeInboxItem(r.item) };
});
