import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withUser } from '@/server/db';
import { resetEnvCache } from '@/server/env';
import { markUnanswered, processDueNotifications, reconcileReminders, type TelegramOutgoing } from '@/server/services/notifications';
import { transitionEvent } from '@/server/services/planning';
import { loadContext } from '@/server/services/profile';
import { onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const t = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toUTC();
const SUNDAY = t('2026-11-01T20:00');

let userId: string;
const sent: TelegramOutgoing[] = [];
const senders = {
  telegram: async (m: TelegramOutgoing) => {
    sent.push(m);
    return { messageId: String(sent.length) };
  },
};

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'lifeos_test_bot';
  resetEnvCache();
  userId = await onboardUser('notify', SUNDAY);
  await withSystem((tx) => tx`insert into telegram_connections (user_id, chat_id, telegram_user_id) values (${userId}, ${900000 + Math.floor(Math.random() * 99999)}, 42)`);
});

afterAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_BOT_USERNAME = '';
  resetEnvCache();
});

async function eventId(kind: string, date: string): Promise<string> {
  const [e] = await withSystem((tx) => tx<{ id: string }[]>`select id from schedule_events where user_id = ${userId} and kind = ${kind} and local_date = ${date}`);
  return e!.id;
}

async function tick(at: DateTime) {
  await withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), at));
  return processDueNotifications(at, senders);
}

describe('reminder worker', () => {
  it('NT-02: an important reminder gets at most one repeat per channel', async () => {
    const lunch = await eventId('meal_lunch', '2026-11-04');
    sent.length = 0;
    await tick(t('2026-11-04T12:00'));
    await tick(t('2026-11-04T13:00'));
    const first = await withSystem((tx) => tx<{ channel: string }[]>`
      select channel from notification_outbox where event_id = ${lunch} and status = 'sent' and reminder_type <> 'repeat'`);
    expect(first.map((r) => r.channel).sort()).toEqual(['in_app', 'telegram']);
    await tick(t('2026-11-04T13:15'));
    await tick(t('2026-11-04T13:30'));
    await tick(t('2026-11-04T13:45'));
    const forLunch = sent.filter((m) => m.buttons.flat().some((b) => b.callbackData?.endsWith(lunch)));
    expect(forLunch).toHaveLength(2); // first + exactly one repeat
    expect(forLunch[1]!.text).toMatch(/Напоминаю ещё раз/);
    const rows = await withSystem((tx) => tx<{ reminderType: string; status: string }[]>`
      select reminder_type, status from notification_outbox where event_id = ${lunch} and channel = 'telegram'`);
    expect(rows.filter((r) => r.reminderType === 'repeat')).toHaveLength(1);
    const [ev] = await withSystem((tx) => tx<{ status: string }[]>`select status from schedule_events where id = ${lunch}`);
    expect(ev!.status).toBe('notified');
    // the window passed without an answer → unanswered, not "missed"
    await markUnanswered(t('2026-11-04T15:00'));
    const [after] = await withSystem((tx) => tx<{ status: string }[]>`select status from schedule_events where id = ${lunch}`);
    expect(after!.status).toBe('unanswered');
  });

  it('NT-03: answering in the web cancels the pending Telegram repeat', async () => {
    const dinner = await eventId('meal_dinner', '2026-11-04');
    sent.length = 0;
    await tick(t('2026-11-04T19:00'));
    await tick(t('2026-11-04T19:30'));
    expect(sent.filter((m) => m.buttons.flat().some((b) => b.callbackData?.endsWith(dinner)))).toHaveLength(1);
    await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), t('2026-11-04T19:35'), dinner, { action: 'start' }));
    await tick(t('2026-11-04T19:46'));
    await tick(t('2026-11-04T20:00'));
    expect(sent.filter((m) => m.buttons.flat().some((b) => b.callbackData?.endsWith(dinner)))).toHaveLength(1);
    const rows = await withSystem((tx) => tx<{ status: string; reminderType: string }[]>`
      select status, reminder_type from notification_outbox where event_id = ${dinner}`);
    expect(rows.filter((r) => r.reminderType === 'repeat').every((r) => r.status === 'cancelled')).toBe(true);
    expect(rows.some((r) => r.status === 'acknowledged')).toBe(true);
  });

  it('skips stale reminders after downtime instead of spamming late', async () => {
    const snack = await eventId('snack', '2026-11-05');
    await tick(t('2026-11-05T09:00'));
    sent.length = 0;
    const r = await processDueNotifications(t('2026-11-05T12:30'), senders); // 11:00 snack is 90 min late
    expect(sent.find((m) => m.buttons.flat().some((b) => b.callbackData?.endsWith(snack)))).toBeUndefined();
    expect(r.skipped).toBeGreaterThan(0);
  });

  it('respects quiet hours chosen by the user', async () => {
    await withSystem((tx) => tx`update profiles set quiet_hours = ${tx.json({ start: '06:00', end: '10:00' })} where user_id = ${userId}`);
    await withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), t('2026-11-06T06:00')));
    const breakfast = await eventId('meal_breakfast', '2026-11-06');
    const rows = await withSystem((tx) => tx<{ status: string }[]>`
      select status from notification_outbox where event_id = ${breakfast} and status = 'scheduled'`);
    expect(rows).toHaveLength(0); // 08:40 falls into quiet hours → no reminder planned
    await withSystem((tx) => tx`update profiles set quiet_hours = null where user_id = ${userId}`);
  });

  it('failed Telegram delivery is recorded with an error and retried, not reported as sent', async () => {
    const proj = await withSystem((tx) => tx<{ id: string; startAt: Date }[]>`
      select id, start_at from schedule_events where user_id = ${userId} and kind = 'own_project' and status = 'planned' order by start_at limit 1`);
    const ev = proj[0]!;
    const start = DateTime.fromJSDate(ev.startAt, { zone: 'utc' });
    await withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), start.minus({ hours: 1 })));
    const failing = { telegram: async () => Promise.reject(new Error('Telegram sendMessage: Forbidden: bot was blocked by the user')) };
    await processDueNotifications(start, failing);
    const [row] = await withSystem((tx) => tx<{ status: string; attempts: number; lastError: string | null }[]>`
      select status, attempts, last_error from notification_outbox where event_id = ${ev.id} and channel = 'telegram'`);
    expect(row!.status).toBe('scheduled');
    expect(row!.attempts).toBe(1);
    expect(row!.lastError).toMatch(/blocked/);
  });
});
