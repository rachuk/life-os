import { z } from 'zod';
import { readJson, userRoute } from '@/server/http';
import { now } from '@/server/context';
import { setTelegramNotifications } from '@/server/telegram/pairing';

const schema = z.object({ enabled: z.boolean() });

export const POST = userRoute(async ({ req, user }) => {
  const { enabled } = await readJson(req, schema);
  return { enabled: await setTelegramNotifications(user.id, enabled, now(), 'web') };
});
