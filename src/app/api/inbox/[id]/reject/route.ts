import { param, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { rejectInboxItem } from '@/server/services/inbox';

export const POST = userRoute(async ({ user, params }) => inUser(user.id, async (tx) => {
  await rejectInboxItem(tx, user.id, param(params, 'id'));
  return { ok: true };
}));
