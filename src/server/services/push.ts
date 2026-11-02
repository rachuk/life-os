import { z } from 'zod';
import { withSystem, withUser } from '../db';
import { env } from '../env';
import { AppError } from '../http';
import { sendWebPush, webPushReady } from '../push/webpush';
import { audit } from './audit';

/**
 * Web push subscriptions (PRD §12.1). Delivery through the browser's push service is never
 * guaranteed — results are reported as "accepted by the push service", not "delivered".
 */

export const pushSubscriptionSchema = z.object({
  endpoint: z
    .string()
    .url()
    .max(2000)
    .refine((u) => u.startsWith('https://'), 'Нужен https endpoint'),
  keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(8).max(100) }),
  userAgent: z.string().max(300).nullable().optional(),
});
export type PushSubscriptionInput = z.infer<typeof pushSubscriptionSchema>;

export function pushStatus() {
  const e = env();
  return {
    enabled: e.ENABLE_WEB_PUSH,
    configured: webPushReady(),
    publicKey: webPushReady() ? (e.VAPID_PUBLIC_KEY ?? null) : null,
  };
}

export async function countSubscriptions(userId: string): Promise<number> {
  const [r] = await withUser(userId, (tx) => tx<{ n: number }[]>`
    select count(*)::int as n from push_subscriptions where user_id = ${userId} and disabled_at is null`);
  return r?.n ?? 0;
}

export async function subscribePush(userId: string, input: PushSubscriptionInput): Promise<{ id: string }> {
  if (!webPushReady()) throw new AppError('PUSH_NOT_CONFIGURED', 'Push не подключён на сервере: не заданы VAPID-ключи (pnpm vapid).', 503);
  // The same browser endpoint may have been registered by another account on this device: the
  // subscription now belongs to whoever is signed in (the old owner simply stops receiving pushes).
  await withSystem((tx) => tx`delete from push_subscriptions where endpoint = ${input.endpoint} and user_id <> ${userId}`);
  return withUser(userId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
      values (${userId}, ${input.endpoint}, ${input.keys.p256dh}, ${input.keys.auth}, ${input.userAgent ?? null})
      on conflict (endpoint) do update set p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, disabled_at = null
      returning id`;
    await audit(tx, userId, 'push_subscription', row!.id, 'subscribed', {}, 'web');
    return { id: row!.id };
  });
}

export async function unsubscribePush(userId: string, endpoint: string | null): Promise<number> {
  return withUser(userId, async (tx) => {
    const rows = endpoint
      ? await tx`delete from push_subscriptions where user_id = ${userId} and endpoint = ${endpoint} returning id`
      : await tx`delete from push_subscriptions where user_id = ${userId} returning id`;
    if (rows.length) await audit(tx, userId, 'push_subscription', null, 'unsubscribed', { count: rows.length }, 'web');
    return rows.length;
  });
}

export type PushSender = (sub: { endpoint: string; p256dh: string; auth: string }, payload: Record<string, unknown>) => Promise<void>;

export async function sendTestPush(userId: string, sender: PushSender = sendWebPush): Promise<{ accepted: number; failed: number; removed: number }> {
  if (!webPushReady()) throw new AppError('PUSH_NOT_CONFIGURED', 'Push не подключён на сервере: не заданы VAPID-ключи (pnpm vapid).', 503);
  const subs = await withUser(userId, (tx) => tx<{ id: string; endpoint: string; p256dh: string; auth: string }[]>`
    select id, endpoint, p256dh, auth from push_subscriptions where user_id = ${userId} and disabled_at is null`);
  if (!subs.length) throw new AppError('NO_PUSH_SUBSCRIPTION', 'На этом аккаунте нет подписанных устройств — сначала включи push на устройстве.', 409);
  let accepted = 0;
  let failed = 0;
  let removed = 0;
  for (const s of subs) {
    try {
      await sender(s, { title: 'Проверка уведомлений', body: 'Push работает. Доставка зависит от устройства и не гарантирована.', url: '/settings#notifications', tag: 'lifeos-test' });
      accepted++;
      await withUser(userId, (tx) => tx`update push_subscriptions set last_success_at = now() where id = ${s.id}`);
    } catch (err) {
      failed++;
      const code = (err as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {
        removed++;
        await withUser(userId, (tx) => tx`update push_subscriptions set disabled_at = now() where id = ${s.id}`);
      }
    }
  }
  return { accepted, failed, removed };
}
