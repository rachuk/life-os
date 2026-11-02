import { DateTime } from 'luxon';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withUser } from '@/server/db';
import { resetEnvCache } from '@/server/env';
import { createProgram, daysWithinPlan, logHabitEvent, programOverview, setDayTotal, startPlan } from '@/server/services/habitChange';
import { loadContext } from '@/server/services/profile';
import { syncXp } from '@/server/services/rewards';
import { setTelegramClient } from '@/server/telegram/api';
import { handleUpdate } from '@/server/telegram/handler';
import { createLinkToken } from '@/server/telegram/pairing';
import { FakeTelegram, findButton, updateFactory } from '../helpers/fakes';
import { onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const t = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toUTC();
const SUNDAY = t('2026-11-01T20:00');
const tg = new FakeTelegram();
const u = updateFactory(3_000_000);
const CHAT = 7_300_001;

let alice: string;
let bob: string;
let programId: string;

beforeAll(async () => {
  process.env.TELEGRAM_BOT_TOKEN = '123456:test-token';
  process.env.TELEGRAM_BOT_USERNAME = 'lifeos_test_bot';
  resetEnvCache();
  setTelegramClient(tg);
  alice = await onboardUser('hc-alice', SUNDAY);
  bob = await onboardUser('hc-bob', SUNDAY);
});

afterAll(() => {
  process.env.TELEGRAM_BOT_TOKEN = '';
  process.env.TELEGRAM_BOT_USERNAME = '';
  resetEnvCache();
  setTelegramClient(undefined);
});

async function log(at: string, reason: string | null = null, kind: 'use' | 'urge_resisted' = 'use') {
  return withUser(alice, async (tx) => logHabitEvent(tx, await loadContext(tx, alice), t(at), programId, { kind, reason }));
}

describe('habit change: observation → plan', () => {
  it('starts with a baseline week; logs keep the work context', async () => {
    const p = await withUser(alice, async (tx) =>
      createProgram(tx, await loadContext(tx, alice), t('2026-11-02T08:00'), { title: 'IQOS', unitLabel: 'стиков', pricePerPackCents: 500, unitsPerPack: 20 }),
    );
    programId = p.id;
    expect(p.phase).toBe('baseline');
    for (const d of ['02', '03', '04', '05']) {
      for (let i = 0; i < 10; i++) await log(`2026-11-${d}T${String(9 + i).padStart(2, '0')}:10`, i % 2 ? 'После кофе' : 'Рабочий стресс');
    }
    const r = await log('2026-11-05T10:30');
    expect(r.todayTotal).toBe(11);
    expect(r.limit).toBeNull(); // observing: no limit yet
    const [ctxRow] = await withSystem((tx) => tx<{ context: { duringWork: boolean } }[]>`
      select context from habit_change_events where id = ${r.id}`);
    expect(ctxRow!.context.duringWork).toBe(true);
  });

  it('a day total overrides the per-use count; resisted urges are counted separately', async () => {
    await withUser(alice, async (tx) => setDayTotal(tx, await loadContext(tx, alice), t('2026-11-06T23:00'), programId, { date: '2026-11-06', total: 9 }));
    await log('2026-11-06T12:00');
    await log('2026-11-06T12:30', null, 'urge_resisted');
    const o = await withUser(alice, async (tx) => programOverview(tx, await loadContext(tx, alice), t('2026-11-06T23:10'), programId));
    expect(o.todayTotal).toBe(9);
    expect(o.todayResisted).toBe(1);
    expect(o.baseline.daysWithData).toBe(5);
    expect(o.baseline.suggestedLimit).toBe(9); // ceil(avg ≈ 10) − 1
    expect(o.patterns.some((x) => x.key === 'during_work')).toBe(true);
  });

  it('the plan lowers the limit weekly; XP only for finished days within the plan, never twice', async () => {
    const now = t('2026-11-09T08:00');
    await withUser(alice, async (tx) => startPlan(tx, await loadContext(tx, alice), now, programId, { direction: 'reduce', dailyLimit: 9, stepPerWeek: 1 }));
    for (let i = 0; i < 8; i++) await log(`2026-11-09T${String(10 + i).padStart(2, '0')}:00`);
    for (let i = 0; i < 11; i++) await log(`2026-11-10T${String(9 + i).padStart(2, '0')}:00`);
    const within = await withUser(alice, async (tx) => daysWithinPlan(tx, await loadContext(tx, alice), '2026-11-09', '2026-11-10'));
    expect(within.map((d) => d.date)).toEqual(['2026-11-09']);
    const o = await withUser(alice, async (tx) => programOverview(tx, await loadContext(tx, alice), t('2026-11-16T09:00'), programId));
    expect(o.limit).toBe(8);
    expect(o.savings.units).toBeGreaterThan(0);
    const x1 = await withUser(alice, async (tx) => syncXp(tx, await loadContext(tx, alice), t('2026-11-11T09:00')));
    const x2 = await withUser(alice, async (tx) => syncXp(tx, await loadContext(tx, alice), t('2026-11-11T09:00')));
    expect(x1).toBeGreaterThan(0);
    expect(x2).toBe(0);
    const xp = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from xp_events where user_id = ${alice} and source_type = 'habit_plan_day'`);
    expect(xp[0]!.n).toBe(1);
  });

  it('another account cannot see or log into this program', async () => {
    const rows = await withUser(bob, (tx) => tx`select id from habit_change_programs where id = ${programId}`);
    expect(rows).toHaveLength(0);
    const err = await withUser(bob, async (tx) => logHabitEvent(tx, await loadContext(tx, bob), t('2026-11-10T10:00'), programId, { kind: 'use' })).catch((e) => e);
    expect((err as Error).message).toMatch(/не найдена/);
  });
});

describe('Telegram /plus', () => {
  it('logs +1 in one message, reason by button, repeated button press applies once', async () => {
    const link = await createLinkToken(alice);
    await handleUpdate(u.text(CHAT, link.command), { client: tg, now: () => t('2026-11-11T10:00') });
    const before = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from habit_change_events where program_id = ${programId} and local_date = '2026-11-11'`);
    const r = await handleUpdate(u.text(CHAT, '+'), { client: tg, now: () => t('2026-11-11T10:05') });
    expect(r.route).toBe('habit:plus');
    const msg = tg.lastSent(CHAT)!;
    expect(msg.text).toMatch(/сегодня <b>1 из 9<\/b>/); // limit drops to 8 only from 16 Nov
    const reasonBtn = findButton(msg, 'hc:r:');
    await handleUpdate(u.callback(CHAT, reasonBtn, msg.messageId), { client: tg, now: () => t('2026-11-11T10:06') });
    await handleUpdate(u.callback(CHAT, reasonBtn, msg.messageId), { client: tg, now: () => t('2026-11-11T10:06') });
    const after = await withSystem((tx) => tx<{ n: number; reasons: number }[]>`
      select count(*)::int as n, count(reason)::int as reasons from habit_change_events where program_id = ${programId} and local_date = '2026-11-11'`);
    expect(after[0]!.n).toBe(before[0]!.n + 1);
    expect(after[0]!.reasons).toBe(1);
    await handleUpdate(u.text(CHAT, '/hold'), { client: tg, now: () => t('2026-11-11T11:00') });
    expect(tg.lastSent(CHAT)!.text).toMatch(/Удержался/);
  });
});
