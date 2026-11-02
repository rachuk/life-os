import { createHash } from 'node:crypto';
import { DateTime } from 'luxon';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setAIProvider } from '@/server/ai/provider';
import { withSystem, withUser } from '@/server/db';
import { integrationStatuses, resetEnvCache } from '@/server/env';
import { AppError } from '@/server/http';
import { captureText } from '@/server/services/inbox';
import { enabledChannels } from '@/server/services/notifications';
import { createManualEvent, createPlanVersion } from '@/server/services/planning';
import { loadContext, updatePrivacy } from '@/server/services/profile';
import { setTelegramClient } from '@/server/telegram/api';
import { handleUpdate } from '@/server/telegram/handler';
import { createLinkToken } from '@/server/telegram/pairing';
import { handleWebhookRequest } from '@/server/telegram/webhook';
import { POST as webhookRoute } from '@/app/api/telegram/webhook/route';
import { callbackDataOf, FakeAI, FakeTelegram, fakeOgg, findButton, testJpeg, updateFactory } from '../helpers/fakes';
import { onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const SUNDAY = DateTime.fromISO('2026-11-01T20:00', { zone: tz }).toUTC();
const TUE_1755 = DateTime.fromISO('2026-11-03T17:55', { zone: tz }).toUTC();
const TUE_1310 = DateTime.fromISO('2026-11-03T13:10', { zone: tz }).toUTC();

const ALICE_CHAT = 7_000_001;
const BOB_CHAT = 7_000_002;
const STRANGER = 7_999_999;

const tg = new FakeTelegram();
const ai = new FakeAI();
const u = updateFactory(1_000_000);
let alice: string;
let bob: string;

const ENV_KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_BOT_USERNAME', 'TELEGRAM_WEBHOOK_SECRET', 'ENABLE_TELEGRAM'] as const;
const savedEnv: Record<string, string | undefined> = {};
function setEnv(over: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const k of ENV_KEYS) if (k in over) process.env[k] = over[k];
  resetEnvCache();
}

const send = (update: unknown, now: DateTime = TUE_1755) => handleUpdate(update, { client: tg, now: () => now });

async function pair(userId: string, chatId: number) {
  const link = await createLinkToken(userId);
  const r = await send(u.text(chatId, link.command));
  expect(r.route).toBe('pair:linked');
}

const q = <T>(fn: Parameters<typeof withSystem<T>>[0]) => withSystem(fn);
async function countRows(sqlText: string, ...params: unknown[]): Promise<number> {
  return withSystem(async (tx) => Number(((await tx.unsafe(sqlText, params as never[]))[0] as unknown as { n: number }).n));
}

beforeAll(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  setEnv({ TELEGRAM_BOT_TOKEN: '123456:test-token', TELEGRAM_BOT_USERNAME: 'lifeos_test_bot', TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret', ENABLE_TELEGRAM: 'true' });
  setTelegramClient(tg);
  setAIProvider(ai);
  alice = await onboardUser('tg-alice', SUNDAY);
  bob = await onboardUser('tg-bob', SUNDAY);
});

afterAll(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  resetEnvCache();
  setTelegramClient(undefined);
  setAIProvider(null);
});

beforeEach(() => {
  ai.see = false;
  ai.hear = false;
  ai.calls = [];
});

// ---------------------------------------------------------------------------
describe('pairing (PRD §19.1)', () => {
  it('creates a one-time deep link and stores only the token hash', async () => {
    const link = await createLinkToken(alice);
    const token = link.command.split(' ')[1]!;
    expect(link.deepLink).toBe(`https://t.me/lifeos_test_bot?start=${token}`);
    expect(Date.parse(link.expiresAt) - Date.now()).toBeGreaterThan(9 * 60_000);
    const rows = await q((tx) => tx<{ tokenHash: string }[]>`select token_hash from telegram_link_tokens where user_id = ${alice} and used_at is null`);
    expect(rows.map((r) => r.tokenHash)).toEqual([createHash('sha256').update(token).digest('hex')]);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it('/start <token> links the chat; the token cannot be reused from another chat', async () => {
    const link = await createLinkToken(alice);
    const r = await send(u.text(ALICE_CHAT, link.command));
    expect(r.route).toBe('pair:linked');
    expect(tg.lastSent(ALICE_CHAT)!.text).toMatch(/Чат подключён/);
    const again = await send(u.text(STRANGER, link.command));
    expect(again.route).toBe('pair:invalid');
    expect(tg.lastSent(STRANGER)!.text).toMatch(/устарела или уже использована/);
    expect(await countRows('select count(*)::int as n from telegram_connections where chat_id = $1', STRANGER)).toBe(0);
  });

  it('an expired token does not link', async () => {
    const link = await createLinkToken(bob);
    await q((tx) => tx`update telegram_link_tokens set expires_at = now() - interval '1 minute' where user_id = ${bob} and used_at is null`);
    const r = await send(u.text(BOB_CHAT, link.command));
    expect(r.route).toBe('pair:invalid');
    expect(await countRows('select count(*)::int as n from telegram_connections where user_id = $1', bob)).toBe(0);
  });

  it('a chat already linked to another account cannot be taken over', async () => {
    const link = await createLinkToken(bob);
    const r = await send(u.text(ALICE_CHAT, link.command));
    expect(r.route).toBe('pair:chat_taken');
    const [c] = await q((tx) => tx<{ userId: string }[]>`select user_id from telegram_connections where chat_id = ${ALICE_CHAT}`);
    expect(c!.userId).toBe(alice);
    await pair(bob, BOB_CHAT);
  });
});

// ---------------------------------------------------------------------------
describe('NT-01: an unpaired chat sees only pairing instructions', () => {
  it('commands and free text get instructions and touch no user data', async () => {
    const inboxBefore = await countRows('select count(*)::int as n from inbox_items');
    for (const text of ['/today', '/now', 'завтра купить молоко', '/work']) {
      const r = await send(u.text(STRANGER, text));
      expect(r.status).toBe('unpaired');
    }
    const replies = tg.sent.filter((m) => m.chatId === STRANGER).slice(-4);
    expect(replies.every((m) => /не привязан/.test(m.text) && !callbackDataOf(m).length)).toBe(true);
    expect(await countRows('select count(*)::int as n from inbox_items')).toBe(inboxBefore);
  });

  it('a photo from an unpaired chat is not downloaded or stored', async () => {
    tg.addFile('stranger-photo', await testJpeg());
    const media = await countRows('select count(*)::int as n from media_assets');
    await send(u.photo(STRANGER, 'stranger-photo'));
    expect(tg.getFileCalls).not.toContain('stranger-photo');
    expect(await countRows('select count(*)::int as n from media_assets')).toBe(media);
  });

  it('a reminder button from an unknown chat is answered once and changes nothing', async () => {
    const [ev] = await q((tx) => tx<{ id: string; status: string }[]>`
      select id, status from schedule_events where user_id = ${alice} and local_date = '2026-11-04' and kind = 'meal_lunch'`);
    const upd = u.callback(STRANGER, `ev:complete:${ev!.id}`);
    await send(upd);
    expect(tg.answersFor(upd.callback_query!.id)).toHaveLength(1);
    const [after] = await q((tx) => tx<{ status: string }[]>`select status from schedule_events where id = ${ev!.id}`);
    expect(after!.status).toBe(ev!.status);
  });

  it("a paired user cannot act on another user's event", async () => {
    const [ev] = await q((tx) => tx<{ id: string; status: string }[]>`
      select id, status from schedule_events where user_id = ${alice} and local_date = '2026-11-04' and kind = 'meal_dinner'`);
    const upd = u.callback(BOB_CHAT, `ev:complete:${ev!.id}`);
    await send(upd);
    expect(tg.answersFor(upd.callback_query!.id)).toEqual([{ id: upd.callback_query!.id, text: 'Событие не найдено' }]);
    const [after] = await q((tx) => tx<{ status: string }[]>`select status from schedule_events where id = ${ev!.id}`);
    expect(after!.status).toBe(ev!.status);
  });

  it('group chats are ignored even if the id matches a paired chat', async () => {
    const before = tg.sent.length;
    const r = await send(u.text(ALICE_CHAT, '/today', { type: 'group' }));
    expect(r.status).toBe('ignored');
    expect(tg.sent.length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('TASK-05: a redelivered update is processed once', () => {
  it('same update_id twice → one inbox item, one reply', async () => {
    const upd = u.text(ALICE_CHAT, 'купить бананы');
    const sentBefore = tg.sent.length;
    expect((await send(upd)).status).toBe('processed');
    expect((await send(upd)).status).toBe('duplicate');
    expect(tg.sent.length).toBe(sentBefore + 1);
    expect(await countRows('select count(*)::int as n from inbox_items where idempotency_key = $1', `tg:${upd.update_id}`)).toBe(1);
    expect(await countRows('select count(*)::int as n from telegram_events where bot_update_id = $1', upd.update_id)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
describe('free text → proposals → «Создать всё»', () => {
  it('nothing is created before confirmation; confirming twice creates once', async () => {
    const tasksBefore = await countRows("select count(*)::int as n from tasks where user_id = $1 and source = 'telegram'", alice);
    await send(u.text(ALICE_CHAT, 'завтра написать брокеру <срочно> & co, купить молоко'));
    const m = tg.lastSent(ALICE_CHAT)!;
    expect(m.text).toMatch(/Проверь/);
    expect(m.text).toContain('&lt;срочно&gt;');
    expect(m.text).not.toContain('<срочно>');
    expect(await countRows("select count(*)::int as n from tasks where user_id = $1 and source = 'telegram'", alice)).toBe(tasksBefore);
    const ok = findButton(m, 'ib:ok:');
    await send(u.callback(ALICE_CHAT, ok, m.messageId));
    expect(tg.lastEdit(ALICE_CHAT)!.text).toMatch(/Готово/);
    const created = await countRows("select count(*)::int as n from tasks where user_id = $1 and source = 'telegram'", alice);
    expect(created).toBeGreaterThan(tasksBefore);
    await send(u.callback(ALICE_CHAT, ok, m.messageId));
    expect(tg.lastEdit(ALICE_CHAT)!.text).toMatch(/Уже сохранено/);
    expect(await countRows("select count(*)::int as n from tasks where user_id = $1 and source = 'telegram'", alice)).toBe(created);
  });

  it('«Отмена» rejects the item and creates nothing', async () => {
    await send(u.text(ALICE_CHAT, 'идея: сделать сайт'));
    const m = tg.lastSent(ALICE_CHAT)!;
    const itemId = findButton(m, 'ib:no:').split(':')[2]!;
    await send(u.callback(ALICE_CHAT, `ib:no:${itemId}`, m.messageId));
    const [row] = await q((tx) => tx<{ processingStatus: string }[]>`select processing_status from inbox_items where id = ${itemId}`);
    expect(row!.processingStatus).toBe('rejected');
  });
});

// ---------------------------------------------------------------------------
describe('NT-04: reminder buttons answer once and apply once', () => {
  it('«Начал» marks the event started exactly once, repeated taps say «Уже отмечено»', async () => {
    const [ev] = await q((tx) => tx<{ id: string }[]>`
      select id from schedule_events where user_id = ${alice} and local_date = '2026-11-03' and kind = 'meal_lunch'`);
    const first = u.callback(ALICE_CHAT, `ev:start:${ev!.id}`, 9001, 'Пора на обед');
    await send(first, TUE_1310);
    expect(tg.answersFor(first.callback_query!.id)).toEqual([{ id: first.callback_query!.id, text: 'Отмечено: начато' }]);
    const [after] = await q((tx) => tx<{ status: string }[]>`select status from schedule_events where id = ${ev!.id}`);
    expect(after!.status).toBe('started');
    expect(tg.lastEdit(ALICE_CHAT)!.text).toMatch(/Пора на обед[\s\S]*Отмечено: начато/);

    const second = u.callback(ALICE_CHAT, `ev:start:${ev!.id}`, 9001, 'Пора на обед');
    await send(second, TUE_1310);
    expect(tg.answersFor(second.callback_query!.id)).toEqual([{ id: second.callback_query!.id, text: 'Уже отмечено' }]);
    expect(await countRows("select count(*)::int as n from audit_events where entity_id = $1 and action = 'transition:start'", ev!.id)).toBe(1);
    expect(await countRows('select count(*)::int as n from telegram_callback_actions where message_id = 9001')).toBe(1);
  });

  it('«+15 мин» on the same reminder moves the event once, not twice', async () => {
    const [ev] = await q((tx) => tx<{ id: string; startAt: Date }[]>`
      select id, start_at from schedule_events where user_id = ${alice} and local_date = '2026-11-03' and kind = 'meal_dinner'`);
    for (let i = 0; i < 2; i++) {
      const upd = u.callback(ALICE_CHAT, `ev:snooze:${ev!.id}`, 9002);
      await send(upd);
      expect(tg.answersFor(upd.callback_query!.id)).toHaveLength(1);
    }
    const [after] = await q((tx) => tx<{ startAt: Date; status: string }[]>`select start_at, status from schedule_events where id = ${ev!.id}`);
    expect(after!.status).toBe('snoozed');
    expect(after!.startAt.getTime() - ev!.startAt.getTime()).toBe(15 * 60_000);
  });

  it('a button for an already completed event answers with its status', async () => {
    const [ev] = await q((tx) => tx<{ id: string }[]>`
      select id from schedule_events where user_id = ${alice} and local_date = '2026-11-03' and kind = 'meal_breakfast'`);
    await send(u.callback(ALICE_CHAT, `ev:complete:${ev!.id}`, 9003), TUE_1310);
    const tap = u.callback(ALICE_CHAT, `ev:start:${ev!.id}`, 9003);
    await send(tap, TUE_1310);
    expect(tg.answersFor(tap.callback_query!.id)[0]!.text).toMatch(/Уже отмечено/);
  });

  it('unknown callback data is still answered exactly once', async () => {
    const upd = u.callback(ALICE_CHAT, 'zz:whatever');
    await send(upd);
    expect(tg.answersFor(upd.callback_query!.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('/work: preview → confirm, stale preview is refreshed (409)', () => {
  const extraCount = () => countRows("select count(*)::int as n from schedule_events where user_id = $1 and kind = 'extra_work' and status <> 'cancelled'", alice);

  it('commits only after «Подтвердить» and with the plan version of the shown preview', async () => {
    await send(u.text(ALICE_CHAT, '/work'));
    const choice = tg.lastSent(ALICE_CHAT)!;
    expect(callbackDataOf(choice)).toEqual(['xd:30:0', 'xd:60:0', 'xd:120:0', 'xd:180:0']);
    await send(u.callback(ALICE_CHAT, 'xd:120:0', choice.messageId));
    const preview = tg.lastEdit(ALICE_CHAT)!;
    expect(preview.messageId).toBe(choice.messageId);
    expect(preview.text).toMatch(/Предпросмотр: \+2 ч/);
    expect(preview.text).toMatch(/Что изменится/);
    const before = await extraCount();

    // the plan changes in another client before the user confirms
    await withUser(alice, (tx) => createPlanVersion(tx, alice, '2026-11-02', { source: 'manual', summary: 'другое окно' }));
    const commit1 = findButton(preview, 'xwc:');
    await send(u.callback(ALICE_CHAT, commit1, preview.messageId));
    const refreshed = tg.lastEdit(ALICE_CHAT)!;
    expect(refreshed.text).toMatch(/План изменился/);
    expect(await extraCount()).toBe(before);

    const commit2 = findButton(refreshed, 'xwc:');
    expect(commit2).not.toBe(commit1);
    await send(u.callback(ALICE_CHAT, commit2, preview.messageId));
    const done = tg.lastEdit(ALICE_CHAT)!;
    expect(done.text).toMatch(/План перестроен/);
    expect(await extraCount()).toBeGreaterThan(before);
    const [v] = await q((tx) => tx<{ actor: string; source: string }[]>`
      select actor, source from plan_versions where user_id = ${alice} order by created_at desc limit 1`);
    expect(v).toEqual({ actor: 'telegram', source: 'extra_work' });

    // an old or repeated confirm button does nothing and keeps the result (with its «Отменить») on screen
    const committed = await extraCount();
    for (const old of [commit1, commit2]) {
      const again = u.callback(ALICE_CHAT, old, preview.messageId);
      await send(again);
      expect(tg.answersFor(again.callback_query!.id)).toEqual([{ id: again.callback_query!.id, text: 'Уже отмечено' }]);
    }
    expect(tg.lastEdit(ALICE_CHAT)!.text).toMatch(/План перестроен/);
    expect(await extraCount()).toBe(committed);

    // undo from the same chat restores the plan
    await send(u.callback(ALICE_CHAT, findButton(done, 'xwu:'), preview.messageId));
    expect(tg.lastEdit(ALICE_CHAT)!.text).toMatch(/отменена/);
    expect(await extraCount()).toBe(before);
  });

  it('«Нужно поработать» from a work reminder opens the duration choice', async () => {
    const [work] = await q((tx) => tx<{ id: string }[]>`select id from schedule_events where user_id = ${alice} and local_date = '2026-11-03' and kind = 'work'`);
    const upd = u.callback(ALICE_CHAT, `xw:0:${work!.id}`, 9100);
    await send(upd);
    expect(tg.answersFor(upd.callback_query!.id)).toHaveLength(1);
    expect(callbackDataOf(tg.lastSent(ALICE_CHAT))).toContain(`xd:60:${work!.id}`);
  });

  it('«Отмена» leaves the plan untouched', async () => {
    const before = await extraCount();
    await send(u.callback(ALICE_CHAT, 'xw:60:0', 9101));
    const p = tg.lastSent(ALICE_CHAT)!;
    await send(u.callback(ALICE_CHAT, findButton(p, 'xwx:'), p.messageId));
    expect(tg.lastEdit(ALICE_CHAT)!.text).toMatch(/план не менялся/);
    expect(await extraCount()).toBe(before);
  });
});

// ---------------------------------------------------------------------------
describe('read-only commands', () => {
  it('/today lists the plan with escaped titles', async () => {
    await withUser(alice, async (tx) =>
      createManualEvent(tx, await loadContext(tx, alice), TUE_1310, { date: '2026-11-03', startTime: '19:00', durationMinutes: 30, title: '<b>Звонок</b> & co', kind: 'custom', priorityClass: 'flexible' }),
    );
    await send(u.text(ALICE_CHAT, '/today'), TUE_1310);
    const m = tg.lastSent(ALICE_CHAT)!.text;
    expect(m).toMatch(/Сегодня, Вт, 3 ноября/);
    expect(m).toContain('&lt;b&gt;Звонок&lt;/b&gt; &amp; co');
    expect(m).toMatch(/Работа/);
  });

  it('/tomorrow, /now and /help answer', async () => {
    await send(u.text(ALICE_CHAT, '/tomorrow'), TUE_1310);
    expect(tg.lastSent(ALICE_CHAT)!.text).toMatch(/Завтра, Ср, 4 ноября/);
    await send(u.text(ALICE_CHAT, '/now'), TUE_1310);
    expect(tg.lastSent(ALICE_CHAT)!.text.length).toBeGreaterThan(3);
    await send(u.text(ALICE_CHAT, '/help'));
    expect(tg.lastSent(ALICE_CHAT)!.text).toMatch(/\/today/);
  });

  it('/stop switches notifications off; the button switches them back on', async () => {
    await send(u.text(BOB_CHAT, '/stop'));
    const [c] = await q((tx) => tx<{ notificationEnabled: boolean }[]>`select notification_enabled from telegram_connections where user_id = ${bob}`);
    expect(c!.notificationEnabled).toBe(false);
    const m = tg.lastSent(BOB_CHAT)!;
    await send(u.callback(BOB_CHAT, 'ntf:on', m.messageId));
    const [c2] = await q((tx) => tx<{ notificationEnabled: boolean }[]>`select notification_enabled from telegram_connections where user_id = ${bob}`);
    expect(c2!.notificationEnabled).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe('voice messages', () => {
  it('without a speech provider the bot says so honestly and does not download the audio', async () => {
    tg.addFile('voice-1', fakeOgg());
    await send(u.voice(ALICE_CHAT, 'voice-1'));
    expect(tg.lastSent(ALICE_CHAT)!.text).toBe('Распознавание голоса не подключено — отправь текстом.');
    expect(tg.getFileCalls).not.toContain('voice-1');
  });

  it('without consent it explains the privacy setting', async () => {
    ai.hear = true;
    await send(u.voice(ALICE_CHAT, 'voice-1'));
    expect(tg.lastSent(ALICE_CHAT)!.text).toMatch(/настройках приватности/);
    expect(ai.calls).not.toContain('transcribe');
  });

  it('with consent: transcript first, then proposals; the raw audio is deleted', async () => {
    ai.hear = true;
    ai.transcript = 'купить хлеб';
    await withUser(alice, (tx) => updatePrivacy(tx, alice, { aiVoiceConsent: true }));
    const sentBefore = tg.sent.length;
    await send(u.voice(ALICE_CHAT, 'voice-1'));
    const out = tg.sent.slice(sentBefore).filter((m) => m.chatId === ALICE_CHAT);
    expect(out[0]!.text).toMatch(/Распознал: «купить хлеб»/);
    expect(callbackDataOf(out[0]).length).toBe(0);
    expect(callbackDataOf(out[1]).some((d) => d.startsWith('ib:ok:'))).toBe(true);
    expect(await countRows("select count(*)::int as n from media_assets where user_id = $1 and kind = 'voice'", alice)).toBe(0);
    const [item] = await q((tx) => tx<{ kind: string; source: string }[]>`select kind, source from inbox_items where user_id = ${alice} order by created_at desc limit 1`);
    expect(item).toEqual({ kind: 'voice', source: 'telegram' });
  });
});

// ---------------------------------------------------------------------------
describe('photos and screenshots', () => {
  async function sendPhoto(chatId: number, fileId: string): Promise<{ mediaId: string; messageId: number }> {
    tg.addFile(fileId, await testJpeg({ exif: true }));
    await send(u.photo(chatId, fileId));
    const m = tg.lastSent(chatId)!;
    expect(m.text).toMatch(/Что на фото/);
    return { mediaId: findButton(m, 'mp:w:').split(':')[2]!, messageId: m.messageId };
  }

  it('HEALTH-06: «Фото прогресса» without opt-in is refused and the file is not kept', async () => {
    const { mediaId, messageId } = await sendPhoto(ALICE_CHAT, 'body-1');
    expect(await countRows('select count(*)::int as n from media_assets where id = $1', mediaId)).toBe(1);
    await send(u.callback(ALICE_CHAT, `mp:p:${mediaId}`, messageId));
    expect(tg.lastEdit(ALICE_CHAT)!.text).toMatch(/только с отдельным согласием[\s\S]*удалён/);
    expect(await countRows('select count(*)::int as n from media_assets where id = $1', mediaId)).toBe(0);
    expect(ai.calls).toEqual([]);
  });

  it('HEALTH-02: a weekly steps screenshot is not saved as daily; the typed daily value is', async () => {
    ai.see = true;
    ai.steps = { readable: true, value: 61200, period: 'week', dateShown: 'Эта неделя', dateIso: null, metric: 'steps', confidence: 0.92, note: null };
    await withUser(alice, (tx) => updatePrivacy(tx, alice, { aiImagesConsent: true }));
    const { mediaId, messageId } = await sendPhoto(ALICE_CHAT, 'steps-week');
    const before = await countRows("select count(*)::int as n from health_measurements where user_id = $1 and metric_type = 'steps'", alice);
    await send(u.callback(ALICE_CHAT, `mp:s:${mediaId}`, messageId));
    const ask = tg.lastSent(ALICE_CHAT)!;
    expect(ask.text).toMatch(/неделю[\s\S]*не сохраняю/);
    expect(callbackDataOf(ask).some((d) => d.startsWith('pv:ok'))).toBe(false);
    expect(await countRows("select count(*)::int as n from health_measurements where user_id = $1 and metric_type = 'steps'", alice)).toBe(before);

    await send(u.text(ALICE_CHAT, '8 500'));
    const [row] = await q((tx) => tx<{ value: number; sourceType: string; sourceMediaId: string; localDate: string }[]>`
      select value, source_type, source_media_id, local_date from health_measurements where user_id = ${alice} and metric_type = 'steps' and source_media_id = ${mediaId}`);
    expect(row).toEqual({ value: 8500, sourceType: 'screenshot', sourceMediaId: mediaId, localDate: '2026-11-03' });
    expect(tg.lastSent(ALICE_CHAT)!.text).toMatch(/Сохранено: 8\s500 шагов за сегодня/);
  });

  it('HEALTH-04: an unreadable weight photo asks for manual entry, the typed value is saved', async () => {
    ai.see = true;
    ai.weight = { readable: false, value: null, unit: null, confidence: 0.1, otherNumbersVisible: false, note: null };
    const { mediaId, messageId } = await sendPhoto(ALICE_CHAT, 'weight-blur');
    await send(u.callback(ALICE_CHAT, `mp:w:${mediaId}`, messageId));
    expect(tg.lastSent(ALICE_CHAT)!.text).toMatch(/Не могу уверенно прочитать[\s\S]*Напиши вес/);
    await send(u.text(ALICE_CHAT, '53,2'));
    const [row] = await q((tx) => tx<{ value: number; sourceType: string; aiConfidence: number | null }[]>`
      select value, source_type, ai_confidence from health_measurements where user_id = ${alice} and source_media_id = ${mediaId}`);
    expect(row).toEqual({ value: 53.2, sourceType: 'photo', aiConfidence: null });
  });

  it('a readable steps screenshot for yesterday is proposed for that day and saved on «Сохранить»', async () => {
    ai.see = true;
    ai.steps = { readable: true, value: 9100, period: 'day', dateShown: 'Вчера', dateIso: '2026-11-02', metric: 'steps', confidence: 0.9, note: null };
    const { mediaId, messageId } = await sendPhoto(ALICE_CHAT, 'steps-yday');
    await send(u.callback(ALICE_CHAT, `mp:s:${mediaId}`, messageId));
    const p = tg.lastSent(ALICE_CHAT)!;
    expect(p.text).toMatch(/9\s100 шагов за Пн, 2 ноября/);
    expect(callbackDataOf(p)).toEqual([`pv:ok:${mediaId}`, `pv:today:${mediaId}`, `pv:man:${mediaId}`]);
    await send(u.callback(ALICE_CHAT, `pv:ok:${mediaId}`, p.messageId));
    const [row] = await q((tx) => tx<{ value: number; localDate: string; aiConfidence: number }[]>`
      select value, local_date, ai_confidence from health_measurements where user_id = ${alice} and source_media_id = ${mediaId}`);
    expect(row).toEqual({ value: 9100, localDate: '2026-11-02', aiConfidence: 0.9 });
  });

  it('HEALTH-03: a meal photo shows what is visible and is logged only after «Часть»', async () => {
    ai.see = true;
    const { mediaId, messageId } = await sendPhoto(ALICE_CHAT, 'meal-1');
    await send(u.callback(ALICE_CHAT, `mp:m:${mediaId}`, messageId), TUE_1310);
    const p = tg.lastSent(ALICE_CHAT)!;
    expect(p.text).toMatch(/Обнаружено:.*рис/);
    expect(p.text).toMatch(/Не видно:/);
    expect(p.text).toMatch(/Вопросы:/);
    expect(await countRows('select count(*)::int as n from meal_logs where media_id = $1', mediaId)).toBe(0);
    await send(u.callback(ALICE_CHAT, `ml:part:${mediaId}`, p.messageId), TUE_1310);
    const [log] = await q((tx) => tx<{ consumptionStatus: string; source: string }[]>`select consumption_status, source from meal_logs where media_id = ${mediaId}`);
    expect(log).toEqual({ consumptionStatus: 'part', source: 'telegram' });
    // a second tap on another answer of the same message is not applied twice
    await send(u.callback(ALICE_CHAT, `ml:part:${mediaId}`, p.messageId), TUE_1310);
    expect(await countRows('select count(*)::int as n from meal_logs where media_id = $1', mediaId)).toBe(1);
  });

  it('a non-image document is refused without downloading', async () => {
    await send(u.document(ALICE_CHAT, 'doc-pdf', 'application/pdf'));
    expect(tg.lastSent(ALICE_CHAT)!.text).toMatch(/не изображение/);
    expect(tg.getFileCalls).not.toContain('doc-pdf');
  });
});

// ---------------------------------------------------------------------------
describe('NT-06 / NT-07: webhook security and "not configured"', () => {
  const run = (req: Request) => {
    const tasks: Promise<unknown>[] = [];
    return handleWebhookRequest(req, (t) => tasks.push(t())).then(async (res) => {
      await Promise.all(tasks);
      return res;
    });
  };
  const req = (body: unknown, secret?: string) =>
    new Request('http://localhost:3000/api/telegram/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(secret !== undefined ? { 'x-telegram-bot-api-secret-token': secret } : {}) },
      body: JSON.stringify(body),
    });

  it('accepts the correct secret and processes the update', async () => {
    const upd = u.text(ALICE_CHAT, '/help');
    const res = await run(req(upd, 'test-webhook-secret'));
    expect(res.status).toBe(200);
    expect(await countRows("select count(*)::int as n from telegram_events where bot_update_id = $1 and status = 'processed'", upd.update_id)).toBe(1);
  });

  it('rejects a wrong or missing secret with 401 and records nothing', async () => {
    for (const secret of ['wrong-secret', '', undefined]) {
      const upd = u.text(ALICE_CHAT, '/today');
      const res = await run(req(upd, secret));
      expect(res.status).toBe(401);
      expect(await countRows('select count(*)::int as n from telegram_events where bot_update_id = $1', upd.update_id)).toBe(0);
    }
    const viaRoute = await webhookRoute(req(u.text(ALICE_CHAT, '/today'), 'nope'));
    expect(viaRoute.status).toBe(401);
  });

  it('rejects malformed bodies', async () => {
    expect((await run(req({ hello: 1 }, 'test-webhook-secret'))).status).toBe(400);
  });

  it('without TELEGRAM_BOT_TOKEN: webhook 503, status "не настроен", web features keep working', async () => {
    setEnv({ TELEGRAM_BOT_TOKEN: '' });
    try {
      const res = await webhookRoute(req(u.text(ALICE_CHAT, '/today'), 'test-webhook-secret'));
      expect(res.status).toBe(503);
      expect(((await res.json()) as { code: string }).code).toBe('TELEGRAM_NOT_CONFIGURED');
      const status = integrationStatuses().find((s) => s.key === 'telegram')!;
      expect(status.configured).toBe(false);
      expect(status.detail).toMatch(/не настроен на сервере/);
      const err = await createLinkToken(alice).catch((e) => e);
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).status).toBe(503);
      const channels = await withUser(alice, async (tx) => enabledChannels(tx, await loadContext(tx, alice)));
      expect(channels).toEqual(['in_app']);
      const r = await captureText(alice, TUE_1310, { text: 'купить сыр', source: 'web' });
      expect(r.item.processingStatus).toBe('proposed');
    } finally {
      setEnv({ TELEGRAM_BOT_TOKEN: '123456:test-token' });
    }
  });

  it('without TELEGRAM_WEBHOOK_SECRET the webhook is disabled (503), not open', async () => {
    setEnv({ TELEGRAM_WEBHOOK_SECRET: '' });
    try {
      expect((await run(req(u.text(ALICE_CHAT, '/today')))).status).toBe(503);
    } finally {
      setEnv({ TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret' });
    }
  });
});

// ---------------------------------------------------------------------------
describe('disconnect', () => {
  it('after unlinking, the chat is treated as unknown', async () => {
    const m = await send(u.callback(BOB_CHAT, 'unlink:yes', 9200));
    expect(m.status).toBe('processed');
    expect(await countRows('select count(*)::int as n from telegram_connections where user_id = $1', bob)).toBe(0);
    const r = await send(u.text(BOB_CHAT, '/today'));
    expect(r.status).toBe('unpaired');
    expect(tg.lastSent(BOB_CHAT)!.text).toMatch(/не привязан/);
  });
});

// ---------------------------------------------------------------------------
describe('blocking and unblocking the bot', () => {
  const state = async () =>
    (await q((tx) => tx<{ notificationEnabled: boolean; blockedAt: Date | null }[]>`
      select notification_enabled, blocked_at from telegram_connections where chat_id = ${ALICE_CHAT}`))[0];
  const member = (status: string) => ({
    update_id: u.nextId(),
    my_chat_member: { chat: { id: ALICE_CHAT, type: 'private' }, from: { id: ALICE_CHAT }, date: 1_793_000_000, new_chat_member: { status } },
  });

  it('reminders resume after unblocking, but a deliberate «выкл» stays off', async () => {
    const before = await state();
    expect(before).toBeDefined();
    await q((tx) => tx`update telegram_connections set notification_enabled = true, blocked_at = null where chat_id = ${ALICE_CHAT}`);
    await send(member('kicked'));
    expect((await state())!.notificationEnabled).toBe(false);
    await send(member('member'));
    expect(await state()).toMatchObject({ notificationEnabled: true, blockedAt: null });

    // switched off on purpose, then blocked and unblocked: stays off
    await q((tx) => tx`update telegram_connections set notification_enabled = false where chat_id = ${ALICE_CHAT}`);
    await send(member('kicked'));
    await send(u.text(ALICE_CHAT, '/start'));
    expect((await state())!.notificationEnabled).toBe(false);
    await q((tx) => tx`update telegram_connections set notification_enabled = ${before!.notificationEnabled} where chat_id = ${ALICE_CHAT}`);
  });
});
