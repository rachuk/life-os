import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { captureSchema, captureText, listPendingInbox, serializeInboxItem } from '@/server/services/inbox';

export const GET = userRoute(async ({ user }) => inUser(user.id, async (tx) => ({ items: (await listPendingInbox(tx, user.id)).map(serializeInboxItem) })));

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, captureSchema);
  const r = await captureText(user.id, now(), { text: input.text, idempotencyKey: input.idempotencyKey, source: 'web' });
  return { ...r, item: serializeInboxItem(r.item) };
});
