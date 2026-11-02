import { mkdirSync, writeFileSync } from 'node:fs';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withUser } from '@/server/db';
import { resetEnvCache } from '@/server/env';
import { markUnanswered, processDueNotifications, reconcileReminders, type TelegramOutgoing } from '@/server/services/notifications';
import { transitionEvent } from '@/server/services/planning';
import { loadContext } from '@/server/services/profile';
import { onboardUser } from '../helpers/db';

/**
 * A whole Monday with the default routine (09–18, prep 60, bed 00:00, gym Tue/Thu, snacks on,
 * 3 h own projects), Telegram connected. The "user" answers some reminders and ignores others.
 * Guards against notification spam: volume, repeats, night messages, late sends.
 * Tuesday: extra work right after the main block — one end-of-day question, not two.
 */
const tz = 'Europe/Lisbon';
const t = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toUTC();
const CHAT = 8_800_001;
let userId: string;
const sent: { at: string; text: string; data: string[] }[] = [];

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123:sim';
  process.env.TELEGRAM_BOT_USERNAME = 'sim_bot';
  resetEnvCache();
  userId = await onboardUser('sim', t('2026-11-01T20:00'));
  await withSystem((tx) => tx`insert into telegram_connections (user_id, chat_id, telegram_user_id) values (${userId}, ${CHAT}, 1)`);
});

afterAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_BOT_USERNAME = '';
  resetEnvCache();
});

/** `SIM_TIMELINE=1 pnpm vitest run tests/integration/day-simulation.test.ts` writes readable timelines to data/. */
function dump(name: string, text: string) {
  if (!process.env.SIM_TIMELINE) return;
  mkdirSync('data', { recursive: true });
  writeFileSync(`data/${name}`, text);
}

async function answer(kind: string, action: 'start' | 'complete' | 'skip', at: DateTime) {
  const [ev] = await withSystem((tx) => tx<{ id: string }[]>`
    select id from schedule_events where user_id = ${userId} and kind = ${kind} and local_date = '2026-11-02'
      and status not in ('completed','skipped','cancelled') order by start_at limit 1`);
  if (ev) await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), at, ev.id, { action }));
}

describe('a simulated Monday', () => {
  it('sends a calm, bounded stream of reminders', async () => {
    const senders = {
      telegram: async (m: TelegramOutgoing) => {
        if (m.chatId === CHAT) sent.push({ at: '', text: m.text.replace(/<[^>]+>/g, '').split('\n')[0]!, data: m.buttons.flat().map((b) => b.callbackData ?? b.url ?? '') });
        return { messageId: String(sent.length) };
      },
    };
    let now = t('2026-11-02T06:00');
    const end = t('2026-11-03T02:00');
    while (now <= end) {
      await withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), now));
      const before = sent.length;
      await processDueNotifications(now, senders);
      for (let i = before; i < sent.length; i++) sent[i]!.at = now.setZone(tz).toFormat('HH:mm');
      await markUnanswered(now);
      const hm = now.setZone(tz).toFormat('HH:mm');
      // the user's behaviour
      if (hm === '08:45') await answer('meal_breakfast', 'complete', now);
      if (hm === '13:20') await answer('meal_lunch', 'start', now); // after the repeat
      if (hm === '18:05') await answer('work', 'complete', now);
      if (hm === '19:40') await answer('meal_dinner', 'complete', now);
      if (hm === '22:00') await answer('review', 'complete', now);
      now = now.plus({ minutes: 5 });
    }

    dump('day-simulation.txt', `--- Monday timeline (${sent.length} Telegram messages) ---\n${sent.map((m) => `${m.at}  ${m.text}`).join('\n')}`);

    expect(sent.length).toBeLessThanOrEqual(14);
    // nothing while asleep (00:05–07:30)
    expect(sent.filter((m) => m.at > '00:05' && m.at < '07:30' && m.at >= '00:00')).toEqual([]);
    // at most one repeat per reminder
    const repeats = sent.filter((m) => m.text.startsWith('Напоминаю ещё раз'));
    const repeatedTitles = repeats.map((m) => m.text);
    expect(new Set(repeatedTitles).size).toBe(repeatedTitles.length);
    // the answered breakfast is never repeated
    expect(sent.filter((m) => /завтрак/i.test(m.text) && m.text.startsWith('Напоминаю'))).toEqual([]);
  }, 120_000);
});

describe('a simulated Tuesday with extra work and the gym', () => {
  it('no «Завершил работу?» once extra work is confirmed; the evening stays coherent', async () => {
    const { extraWorkCommit, extraWorkPreview } = await import('@/server/services/planning');
    const { computeNow } = await import('@/domain/planner/now');
    const { dayEvents, toPlanEvent } = await import('@/server/services/planning');
    const out: { at: string; text: string }[] = [];
    const senders = {
      telegram: async (m: TelegramOutgoing) => {
        if (m.chatId === CHAT) out.push({ at: '', text: m.text.replace(/<[^>]+>/g, '').split('\n')[0]! });
        return { messageId: String(out.length) };
      },
    };
    const nowStates: string[] = [];
    let now = t('2026-11-03T07:00');
    const end = t('2026-11-04T01:00');
    while (now <= end) {
      const hm = now.setZone(tz).toFormat('HH:mm');
      if (hm === '17:55') {
        await withUser(userId, async (tx) => {
          const ctx = await loadContext(tx, userId);
          const p = await extraWorkPreview(tx, ctx, now, { date: '2026-11-03', startMode: 'after_work', durationMinutes: 120, reason: null });
          await extraWorkCommit(tx, ctx, now, { date: '2026-11-03', startMode: 'after_work', startTime: null, durationMinutes: 120, reason: null, expectedPlanVersion: p.basePlanVersion, acknowledgeRisks: true });
        });
      }
      await withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), now));
      const before = out.length;
      await processDueNotifications(now, senders);
      for (let i = before; i < out.length; i++) out[i]!.at = hm;
      await markUnanswered(now);
      if (['18:00', '18:30', '20:05', '20:40', '21:10'].includes(hm)) {
        const s = await withUser(userId, async (tx) => {
          const ctx = await loadContext(tx, userId);
          const rows = await dayEvents(tx, ctx, '2026-11-03');
          return computeNow({ now, tz, events: rows.map(toPlanEvent), workoutLeadMinutes: 30, eveningReviewTime: '23:15' });
        });
        nowStates.push(`${hm} ${s.mode}: ${s.headline}`);
      }
      if (hm === '20:05') await answer2('extra_work', 'complete', now);
      if (hm === '20:35') await answer2('workout', 'start', now);
      now = now.plus({ minutes: 5 });
    }
    const plan = await withSystem((tx) => tx<{ kind: string; title: string; status: string; startAt: Date; endAt: Date }[]>`
      select kind, title, status, start_at, end_at from schedule_events
      where user_id = ${userId} and local_date = '2026-11-03' and status <> 'cancelled' order by start_at`);
    const hhmm = (d: Date) => DateTime.fromJSDate(d).setZone(tz).toFormat('HH:mm');
    dump(
      'day-simulation-tuesday.txt',
      `--- Tuesday timeline (${out.length}) ---\n${out.map((m) => `${m.at}  ${m.text}`).join('\n')}\n--- «Сейчас» ---\n${nowStates.join('\n')}\n--- plan ---\n${plan.map((e) => `${hhmm(e.startAt)}–${hhmm(e.endAt)} ${e.kind} ${e.title} [${e.status}]`).join('\n')}`,
    );
    expect(plan.find((e) => e.kind === 'work')?.status).toBe('completed');
    expect(out.find((m) => m.at === '18:00' && /Завершил работу/.test(m.text))).toBeUndefined();
    expect(nowStates.find((x) => x.startsWith('20:05'))).toMatch(/extra_work_end|Закончил дополнительную/);
    expect(out.length).toBeLessThanOrEqual(14);
  }, 180_000);
});

async function answer2(kind: string, action: 'start' | 'complete' | 'skip', at: DateTime) {
  const [ev] = await withSystem((tx) => tx<{ id: string }[]>`
    select id from schedule_events where user_id = ${userId} and kind = ${kind} and local_date = '2026-11-03'
      and status not in ('completed','skipped','cancelled') order by start_at limit 1`);
  if (ev) await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), at, ev.id, { action }));
}

describe('a simulated Wednesday: «Нужно поработать» after the 18:00 question', () => {
  it('drops the pending repeat and asks once at the end of the extra block', async () => {
    const { extraWorkCommit, extraWorkPreview } = await import('@/server/services/planning');
    const out: { at: string; text: string }[] = [];
    const senders = {
      telegram: async (m: TelegramOutgoing) => {
        if (m.chatId === CHAT) out.push({ at: '', text: m.text.replace(/<[^>]+>/g, '').split('\n')[0]! });
        return { messageId: String(out.length) };
      },
    };
    let now = t('2026-11-04T17:30');
    while (now <= t('2026-11-04T19:30')) {
      const hm = now.setZone(tz).toFormat('HH:mm');
      if (hm === '18:05') {
        await withUser(userId, async (tx) => {
          const ctx = await loadContext(tx, userId);
          const p = await extraWorkPreview(tx, ctx, now, { date: '2026-11-04', startMode: 'now', durationMinutes: 60, reason: null });
          await extraWorkCommit(tx, ctx, now, { date: '2026-11-04', startMode: 'now', startTime: null, durationMinutes: 60, reason: null, expectedPlanVersion: p.basePlanVersion, acknowledgeRisks: true });
        });
      }
      await withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), now));
      const before = out.length;
      await processDueNotifications(now, senders);
      for (let i = before; i < out.length; i++) out[i]!.at = hm;
      await markUnanswered(now);
      now = now.plus({ minutes: 5 });
    }
    const work = out.filter((m) => /Завершил работу/.test(m.text));
    expect(work.map((m) => m.at)).toEqual(['18:00']); // asked once, no 18:15 repeat
    expect(out.find((m) => /Закончил дополнительную/.test(m.text))?.at).toBe('19:05');
  }, 120_000);
});
