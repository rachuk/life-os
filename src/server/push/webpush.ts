import webpush from 'web-push';
import { env } from '../env';

let configured = false;

export function webPushReady(): boolean {
  const e = env();
  return e.ENABLE_WEB_PUSH && !!e.VAPID_PUBLIC_KEY && !!e.VAPID_PRIVATE_KEY;
}

export async function sendWebPush(sub: { endpoint: string; p256dh: string; auth: string }, payload: Record<string, unknown>): Promise<void> {
  const e = env();
  if (!webPushReady()) throw new Error('web push not configured');
  if (!configured) {
    webpush.setVapidDetails(e.VAPID_SUBJECT, e.VAPID_PUBLIC_KEY!, e.VAPID_PRIVATE_KEY!);
    configured = true;
  }
  await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
}
