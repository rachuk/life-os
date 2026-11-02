import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { login } from '@/server/auth/session';
import { createUser } from '@/server/auth/users';
import { withSystem, withUser } from '@/server/db';
import { resetEnvCache } from '@/server/env';
import { markUnanswered, processDueNotifications, reconcileReminders, type TelegramOutgoing } from '@/server/services/notifications';
import { transitionEvent } from '@/server/services/planning';
import { loadContext } from '@/server/services/profile';
import { onboardUser, PASSWORD } from '../helpers/db';

/** Regression tests for the findings of the independent review (2 Nov 2026). */
const tz = 'Europe/Lisbon';
const t = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toUTC();
let userId: string;
let failTelegram = false;
const sent: TelegramOutgoing[] = [];
const senders = {
  telegram: async (m: TelegramOutgoing) => {
    if (failTelegram) throw new Error('network down');
    sent.push(m);
    return { messageId: String(sent.length) };
  },
};

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'lifeos_test_bot';
  resetEnvCache();
  userId = await onboardUser('fixes', t('2026-11-01T20:00'));
  await withSystem((tx) => tx`insert into telegram_connections (user_id, chat_id, telegram_user_id) values (${userId}, ${700000 + Math.floor(Math.random() * 99999)}, 43)`);
});

afterAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_BOT_USERNAME = '';
  resetEnvCache();
});

const reconcile = (at: DateTime) => withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), at));
const eventOf = async (kind: string, date: string) =>
  (await withSystem((tx) => tx<{ id: string }[]>`select id from schedule_events where user_id = ${userId} and kind = ${kind} and local_date = ${date} order by start_at limit 1`))[0]!.id;
const outbox = (eventId: string) =>
  withSystem((tx) => tx<{ channel: string; reminderType: string; status: string; cancelReason: string | null }[]>`
    select channel, reminder_type, status, cancel_reason from notification_outbox where event_id = ${eventId} order by scheduled_at, channel`);

describe('review fixes', () => {
  it('a reminder whose send failed survives the next reconcile and is retried', async () => {
    const lunch = await eventOf('meal_lunch', '2026-11-03');
    await reconcile(t('2026-11-03T12:00'));
    failTelegram = true;
    await processDueNotifications(t('2026-11-03T13:00'), senders);
    failTelegram = false;
    await reconcile(t('2026-11-03T13:01')); // the worker / any materialisation reconciles in between
    sent.length = 0;
    await processDueNotifications(t('2026-11-03T13:03'), senders);
    expect(sent.some((m) => m.buttons.flat().some((b) => b.callbackData?.endsWith(lunch)))).toBe(true);
    const tg = (await outbox(lunch)).find((r) => r.channel === 'telegram' && r.reminderType === 'start');
    expect(tg?.status).toBe('sent');
  });

  it('a reminder for an event moved beyond the reconcile window is not sent at the old time', async () => {
    const workout = await eventOf('workout', '2026-11-05'); // Thu 21:00, lead reminder 20:30
    await reconcile(t('2026-11-05T19:00'));
    // moved to Saturday by a change whose reconcile could not see it any more
    await withSystem((tx) => tx`update schedule_events set start_at = start_at + interval '2 days', end_at = end_at + interval '2 days', local_date = '2026-11-07' where id = ${workout}`);
    sent.length = 0;
    await processDueNotifications(t('2026-11-05T20:30'), senders);
    expect(sent.filter((m) => m.buttons.flat().some((b) => b.callbackData?.endsWith(workout)))).toEqual([]);
    expect((await outbox(workout)).filter((r) => r.status === 'cancelled').every((r) => r.cancelReason === 'plan_changed')).toBe(true);
  });

  it('a snoozed event that gets reminded again and is ignored becomes unanswered', async () => {
    const dinner = await eventOf('meal_dinner', '2026-11-06');
    const at = t('2026-11-06T19:30');
    await reconcile(t('2026-11-06T19:00'));
    await processDueNotifications(at, senders);
    await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), at, dinner, { action: 'snooze', snoozeMinutes: 15 }));
    await reconcile(t('2026-11-06T19:40'));
    await processDueNotifications(t('2026-11-06T19:46'), senders);
    await markUnanswered(t('2026-11-06T21:30'));
    const [ev] = await withSystem((tx) => tx<{ status: string }[]>`select status from schedule_events where id = ${dinner}`);
    expect(ev!.status).toBe('unanswered');
  });

  it('«Начал» on a work block keeps its «Закончил?» question', async () => {
    const work = await eventOf('work', '2026-11-09');
    await reconcile(t('2026-11-09T09:00'));
    await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), t('2026-11-09T09:05'), work, { action: 'start' }));
    await reconcile(t('2026-11-09T09:10'));
    sent.length = 0;
    await processDueNotifications(t('2026-11-09T18:00'), senders);
    expect(sent.some((m) => /Завершил работу/.test(m.text))).toBe(true);
  });

  it('failed logins from one client do not lock the owner out from another', async () => {
    const email = `owner-${randomUUID().slice(0, 8)}@test.local`;
    await createUser({ email, password: PASSWORD, role: 'test' });
    for (let i = 0; i < 9; i++) await login(email, 'wrong-password', 'attacker-ip', null);
    expect((await login(email, PASSWORD, 'attacker-ip', null)).ok).toBe(false); // that client is throttled
    expect((await login(email, PASSWORD, 'owner-ip', null)).ok).toBe(true);
  });
});
