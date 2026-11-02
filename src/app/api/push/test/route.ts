import { userRoute } from '@/server/http';
import { sendTestPush } from '@/server/services/push';

/** Sends a test notification to every subscribed device; 503 when VAPID keys are not set. */
export const POST = userRoute(async ({ user }) => sendTestPush(user.id));
