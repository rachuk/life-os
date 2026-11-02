import { z } from 'zod';
import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { deliveryDiagnostics, listInApp, markRead, unreadCount } from '@/server/services/notifications';

export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx) => ({
    items: await listInApp(tx, user.id),
    unread: await unreadCount(tx, user.id),
    diagnostics: url.searchParams.get('diagnostics') ? await deliveryDiagnostics(tx, user.id) : undefined,
  })),
);

const schema = z.object({ ids: z.union([z.array(z.string().uuid()).max(200), z.literal('all')]) });
export const POST = userRoute(async ({ req, user }) => {
  const { ids } = await readJson(req, schema);
  return inUser(user.id, async (tx) => {
    await markRead(tx, user.id, ids);
    return { unread: await unreadCount(tx, user.id) };
  });
});
