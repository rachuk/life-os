import { z } from 'zod';
import { readJson, userRoute } from '@/server/http';
import { unsubscribePush } from '@/server/services/push';

const schema = z.object({ endpoint: z.string().url().max(2000).nullable().optional() });

/** Removes this device's subscription (or all of the user's when no endpoint is given). */
export const POST = userRoute(async ({ req, user }) => {
  const { endpoint } = await readJson(req, schema);
  return { removed: await unsubscribePush(user.id, endpoint ?? null) };
});
