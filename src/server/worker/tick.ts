import type { DateTime } from 'luxon';
import { addDays, localDateOf, weekStartOf } from '@/domain/time';
import { markUnanswered, processDueNotifications, reconcileAllUsers, type ChannelSenders } from '../services/notifications';
import { ensureMaterialized } from '../services/planning';
import { telegramClient } from '../telegram/api';
import { sendWebPush, webPushReady } from '../push/webpush';
import { purgeExpiredMedia } from '../services/retention';

export function defaultSenders(): ChannelSenders {
  const tg = telegramClient();
  return {
    telegram: tg
      ? async (m) => ({ messageId: String((await tg.sendMessage(m.chatId, m.text, { buttons: m.buttons })).messageId) })
      : undefined,
    webPush: webPushReady() ? sendWebPush : undefined,
  };
}

let lastReconcile = 0;

/**
 * One worker iteration (PRD §12.4): keep the next days materialised, reconcile reminders,
 * mark unanswered events, send due notifications, purge expired media. Idempotent.
 */
export async function runWorkerTick(now: DateTime, senders: ChannelSenders = defaultSenders(), opts: { forceReconcile?: boolean } = {}) {
  const report: Record<string, unknown> = { at: now.toISO() };
  if (opts.forceReconcile || Date.now() - lastReconcile > 5 * 60_000) {
    report.users = await reconcileAllUsers(now, async (tx, ctx) => {
      const today = localDateOf(now, ctx.tz);
      await ensureMaterialized(tx, ctx, now, today, addDays(weekStartOf(today), 13));
    });
    lastReconcile = Date.now();
  }
  report.unanswered = await markUnanswered(now);
  report.notifications = await processDueNotifications(now, senders);
  report.purged = await purgeExpiredMedia(now).catch(() => 0);
  return report;
}
