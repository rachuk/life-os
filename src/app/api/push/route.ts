import { userRoute } from '@/server/http';
import { countSubscriptions, pushStatus } from '@/server/services/push';

/** Server-side push readiness + the public VAPID key (not a secret) + subscribed devices count. */
export const GET = userRoute(async ({ user }) => ({ ...pushStatus(), devices: await countSubscriptions(user.id) }));
