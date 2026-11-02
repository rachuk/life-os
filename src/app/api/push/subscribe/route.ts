import { readJson, userRoute } from '@/server/http';
import { pushSubscriptionSchema, subscribePush } from '@/server/services/push';

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, pushSubscriptionSchema);
  return subscribePush(user.id, { ...input, userAgent: input.userAgent ?? req.headers.get('user-agent')?.slice(0, 300) ?? null });
});
