import type { DateTime } from 'luxon';
import { STATUS_LABELS, type EventStatus } from '@/domain/types';
import { inUser, now as clockNow } from '../context';
import { isUuid, withSystem } from '../db';
import { AppError } from '../http';
import { transitionEvent } from '../services/planning';
import { telegramClient, type TelegramClient } from './api';
import { confirmInbox, handleFreeText, handleVoice, rejectInbox } from './capture';
import { cmdDay, cmdHelp, cmdNow, cmdStop, cmdWork, notificationsAction, unlinkAction } from './commands';
import { cancelExtraWork, commitExtraWork, showDurationChoice, showExtraWorkPreview, undoExtraWork } from './extraWork';
import { esc, HELP_TEXT, PAIRING_TEXT } from './format';
import { connectionForChat, consumeLinkToken, markChatBlocked } from './pairing';
import { choosePurpose, handleAwaitedValue, handleIncomingImage, mealAction, photoValueAction } from './photos';
import { claimButton, edit, reply, type ChatSession } from './session';
import { getPending, setPending } from './state';
import { isUpdate, type TgCallbackQuery, type TgMessage, type TgUpdate } from './types';

/**
 * Single entry point for Telegram updates — used by the webhook route and by `pnpm bot:poll`.
 *  - Idempotency: every update_id is recorded once in telegram_events; a redelivered update is ignored (TASK-05).
 *  - Unknown or unpaired chats only get pairing instructions; no user data is read or written (NT-01).
 *  - Only private chats are served.
 *  - Callback queries are always answered exactly once; one-shot buttons apply once (NT-04).
 * Business logic lives in src/server/services/*; this module only routes and formats.
 */

export interface HandlerDeps {
  client: TelegramClient;
  now: () => DateTime;
}

export type HandleStatus = 'processed' | 'duplicate' | 'ignored' | 'unpaired' | 'failed' | 'disabled';

export interface HandleResult {
  status: HandleStatus;
  route?: string;
}

const UNPAIRED_REPLY_LIMIT = 5; // per chat per 10 minutes — no amplification for strangers

async function recordUpdate(update: TgUpdate, chatId: number | null, type: string): Promise<string | null> {
  const [row] = await withSystem((tx) => tx<{ id: string }[]>`
    insert into telegram_events (bot_update_id, chat_id, update_type)
    values (${update.update_id}, ${chatId}, ${type})
    on conflict (bot_update_id) do nothing returning id`);
  return row?.id ?? null;
}

async function finishUpdate(eventId: string, status: 'processed' | 'ignored' | 'failed', result: Record<string, unknown>, userId?: string | null) {
  await withSystem((tx) => tx`
    update telegram_events set status = ${status}, processed_at = now(), result_json = ${tx.json(result as never)},
      user_id = coalesce(${userId ?? null}::uuid, user_id)
    where id = ${eventId}`).catch(() => {});
}

function updateKind(u: TgUpdate): { type: string; chat: TgMessage['chat'] | null } {
  if (u.message) return { type: 'message', chat: u.message.chat };
  if (u.callback_query) return { type: 'callback_query', chat: u.callback_query.message?.chat ?? null };
  if (u.my_chat_member) return { type: 'my_chat_member', chat: u.my_chat_member.chat };
  if (u.edited_message) return { type: 'edited_message', chat: u.edited_message.chat };
  return { type: 'other', chat: null };
}

export async function handleUpdate(raw: unknown, deps: Partial<HandlerDeps> = {}): Promise<HandleResult> {
  if (!isUpdate(raw)) return { status: 'ignored' };
  const client = deps.client ?? telegramClient();
  if (!client) return { status: 'disabled' };
  const update = raw;
  const { type, chat } = updateKind(update);
  const chatId = chat?.id ?? update.callback_query?.from.id ?? null;
  const eventId = await recordUpdate(update, Number.isSafeInteger(chatId) ? chatId : null, type);
  if (!eventId) return { status: 'duplicate' };

  const cq = update.callback_query;
  let answered = false;
  const answer = async (text?: string) => {
    if (!cq || answered) return;
    answered = true;
    await client.answerCallbackQuery(cq.id, text).catch(() => {});
  };

  let userId: string | null = null;
  try {
    if (!chatId || (chat && chat.type !== 'private')) {
      await answer('Бот работает только в личном чате');
      await finishUpdate(eventId, 'ignored', { reason: 'not_private' });
      return { status: 'ignored' };
    }
    if (update.my_chat_member) {
      const st = update.my_chat_member.new_chat_member?.status;
      if (st === 'kicked' || st === 'left') await markChatBlocked(chatId);
      await finishUpdate(eventId, 'processed', { route: `member:${st ?? '?'}` });
      return { status: 'processed', route: 'my_chat_member' };
    }
    const msg = update.message;
    if (!msg && !cq) {
      await finishUpdate(eventId, 'ignored', { reason: type });
      return { status: 'ignored' };
    }

    // /start <token>: the only thing an unpaired chat can do
    const start = msg?.text?.match(/^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/);
    if (msg && start?.[1]) {
      const from = msg.from;
      const r = await consumeLinkToken(start[1], { chatId, telegramUserId: from?.id ?? chatId, username: from?.username ?? null });
      const texts: Record<typeof r.status, string> = {
        linked: `✓ Чат подключён к Life OS.\n\n${HELP_TEXT}`,
        already: 'Этот чат уже подключён к твоему аккаунту.',
        invalid: 'Ссылка устарела или уже использована. Создай новую: Настройки → Telegram → «Подключить».',
        chat_taken: 'Этот чат уже привязан к другому аккаунту Life OS. Сначала отвяжи его там.',
      };
      await client.sendMessage(chatId, texts[r.status]);
      userId = 'userId' in r ? r.userId : null;
      await finishUpdate(eventId, 'processed', { route: `pair:${r.status}` }, userId);
      return { status: 'processed', route: `pair:${r.status}` };
    }

    const conn = await connectionForChat(chatId);
    const fromId = msg?.from?.id ?? cq?.from.id;
    if (!conn || (fromId !== undefined && fromId !== conn.telegramUserId)) {
      await answer('Этот чат не привязан к аккаунту Life OS');
      if (msg && (await recentUnpairedReplies(chatId, eventId)) < UNPAIRED_REPLY_LIMIT) await client.sendMessage(chatId, PAIRING_TEXT);
      await finishUpdate(eventId, 'ignored', { reason: 'unpaired' });
      return { status: 'unpaired' };
    }
    userId = conn.userId;
    await withSystem((tx) => tx`update telegram_connections set last_update_id = greatest(coalesce(last_update_id, 0), ${update.update_id}) where chat_id = ${chatId}`);
    const s: ChatSession = { client, chatId, userId, now: (deps.now ?? clockNow)(), updateId: update.update_id };

    let route: string;
    if (cq) {
      route = await handleCallback(s, cq, answer);
    } else {
      route = await handleMessage(s, msg!);
    }
    await finishUpdate(eventId, 'processed', { route }, userId);
    return { status: 'processed', route };
  } catch (e) {
    // never log message content (error messages can quote values) — only the error class/code and the update row id
    console.error(`[telegram ${eventId}]`, e instanceof AppError ? `AppError ${e.code}` : e instanceof Error ? e.name : 'unknown');
    const wasAnswered = answered;
    await answer(e instanceof AppError && e.status < 500 ? e.message : 'Не получилось — попробуй ещё раз');
    if (userId && (update.message || wasAnswered)) {
      await client
        .sendMessage(chatId!, e instanceof AppError && e.status < 500 ? esc(e.message) : 'Что-то пошло не так. Попробуй ещё раз или открой приложение.')
        .catch(() => {});
    }
    await finishUpdate(eventId, 'failed', { error: e instanceof AppError ? e.code : 'INTERNAL' }, userId);
    return { status: 'failed' };
  } finally {
    await answer();
  }
}

async function recentUnpairedReplies(chatId: number, currentEventId: string): Promise<number> {
  const [r] = await withSystem((tx) => tx<{ n: number }[]>`
    select count(*)::int as n from telegram_events
    where chat_id = ${chatId} and user_id is null and id <> ${currentEventId} and received_at > now() - interval '10 minutes'`);
  return r?.n ?? 0;
}

// ---------------------------------------------------------------------------
// messages
// ---------------------------------------------------------------------------
async function handleMessage(s: ChatSession, msg: TgMessage): Promise<string> {
  const text = msg.text?.trim();
  if (text?.startsWith('/')) {
    const cmd = text.split(/\s+/)[0]!.replace(/@\w+$/, '').toLowerCase();
    switch (cmd) {
      case '/start':
      case '/help':
        await cmdHelp(s);
        break;
      case '/today':
        await cmdDay(s, 'today');
        break;
      case '/tomorrow':
        await cmdDay(s, 'tomorrow');
        break;
      case '/now':
        await cmdNow(s);
        break;
      case '/work':
        await cmdWork(s);
        break;
      case '/stop':
        await cmdStop(s);
        break;
      default:
        await reply(s, 'Не знаю такую команду. /help — список команд.');
        return 'command:unknown';
    }
    return `command:${cmd}`;
  }
  if (text) {
    const pending = await getPending(s.userId);
    if (pending?.kind === 'await_value') {
      if (await handleAwaitedValue(s, pending, text)) return 'photo:value';
      await setPending(s.userId, null); // not a number → treat as a normal message
    }
    await handleFreeText(s, text, msg.message_id);
    return 'capture:text';
  }
  const voice = msg.voice ?? msg.audio ?? msg.video_note;
  if (voice) {
    await handleVoice(s, voice, msg.message_id);
    return 'capture:voice';
  }
  if (msg.photo?.length) {
    const best = [...msg.photo].sort((a, b) => b.width * b.height - a.width * a.height)[0]!;
    await handleIncomingImage(s, { fileId: best.file_id, fileSize: best.file_size, mime: null });
    return 'media:photo';
  }
  if (msg.document) {
    await handleIncomingImage(s, { fileId: msg.document.file_id, fileSize: msg.document.file_size, mime: msg.document.mime_type ?? 'application/octet-stream' });
    return 'media:document';
  }
  await reply(s, 'Такие сообщения я пока не понимаю. Пиши текстом, присылай голосовые или фото. /help — что я умею.');
  return 'message:unsupported';
}

// ---------------------------------------------------------------------------
// inline buttons
// ---------------------------------------------------------------------------
const TRANSITION_DONE: Record<string, string> = {
  start: 'Отмечено: начато',
  complete: 'Отмечено: выполнено',
  snooze: 'Отложено на 15 минут',
  skip: 'Отмечено: пропущено',
};

async function eventTransition(s: ChatSession, cq: TgCallbackQuery, transition: 'start' | 'complete' | 'snooze' | 'skip', eventId: string): Promise<string> {
  try {
    const r = await inUser(s.userId, (tx, ctx) =>
      transitionEvent(tx, ctx, s.now, eventId, transition === 'snooze' ? { action: 'snooze', snoozeMinutes: 15 } : { action: transition }, 'telegram'),
    );
    if (!r.changed) return 'Уже отмечено';
    const original = cq.message?.text ? esc(cq.message.text) : '';
    const extra = r.warnings.length ? `\n${r.warnings.map((w) => `⚠️ ${esc(w)}`).join('\n')}` : '';
    if (cq.message) await edit(s, cq.message.message_id, `${original}\n\n✓ <i>${esc(TRANSITION_DONE[transition] ?? r.message)}</i>${extra}`);
    return TRANSITION_DONE[transition] ?? r.message;
  } catch (e) {
    if (e instanceof AppError && e.code === 'INVALID_TRANSITION') {
      const st = (e.details as { event?: { status?: EventStatus } } | undefined)?.event?.status;
      return st ? `Уже отмечено: ${STATUS_LABELS[st].toLowerCase()}` : 'Уже отмечено';
    }
    if (e instanceof AppError && e.code === 'NOT_FOUND') return 'Событие не найдено';
    throw e;
  }
}

/** Callback data formats are listed here; anything else is ignored. */
async function handleCallback(s: ChatSession, cq: TgCallbackQuery, answer: (t?: string) => Promise<void>): Promise<string> {
  const data = cq.data ?? '';
  const messageId = cq.message?.message_id;
  const parts = data.split(':');
  const [p0, p1, p2] = parts;

  /** Buttons whose effect must happen once per message (reminder answers, purpose choice, meal answer…). */
  const once = async (fn: () => Promise<string>, earlyAnswer?: string): Promise<string> => {
    const claim = await claimButton(s, messageId ?? 0, data);
    if (!claim.claimed) {
      await answer('Уже отмечено');
      return 'already';
    }
    if (earlyAnswer) await answer(earlyAnswer); // slow steps (AI) must not keep the button spinning
    try {
      const text = await fn();
      await answer(text);
      return text;
    } catch (e) {
      await claim.release();
      throw e;
    }
  };

  switch (p0) {
    case 'ev': {
      if (!p1 || !['start', 'complete', 'snooze', 'skip'].includes(p1) || !isUuid(p2)) break;
      await once(() => eventTransition(s, cq, p1 as 'start', p2));
      return `cb:ev:${p1}`;
    }
    case 'xw': {
      // from reminders / now: new message with duration choice or a preview
      const minutes = Number(p1);
      const ref = isUuid(p2) ? p2 : '0';
      await answer();
      if (!minutes) await showDurationChoice(s, ref);
      else await showExtraWorkPreview(s, minutes, ref);
      return 'cb:xw';
    }
    case 'xd': {
      // from the duration choice / "сократить до": the preview replaces that message
      const minutes = Number(p1);
      if (!Number.isInteger(minutes) || minutes < 15 || minutes > 480) break;
      await answer();
      await showExtraWorkPreview(s, minutes, isUuid(p2) ? p2 : '0', { editMessageId: messageId });
      return 'cb:xd';
    }
    case 'xwc':
      if (!p1) break;
      await answer('Применяю…');
      await commitExtraWork(s, p1, messageId);
      return 'cb:xw_commit';
    case 'xwx':
      if (!p1) break;
      await answer(await cancelExtraWork(s, p1, messageId));
      return 'cb:xw_cancel';
    case 'xwu':
      if (!isUuid(p1)) break;
      await once(() => undoExtraWork(s, p1, messageId));
      return 'cb:xw_undo';
    case 'ib': {
      if (!isUuid(p2)) break;
      if (p1 === 'ok' || p1 === 'rp') {
        await answer(await confirmInbox(s, p2, p1 === 'rp', messageId));
        return `cb:inbox_${p1}`;
      }
      if (p1 === 'no') {
        await answer(await rejectInbox(s, p2, messageId));
        return 'cb:inbox_no';
      }
      break;
    }
    case 'mp': {
      if (!p1 || !isUuid(p2)) break;
      await once(() => choosePurpose(s, p1, p2, messageId), 'Принято');
      return `cb:media_${p1}`;
    }
    case 'pv': {
      if (!p1 || !isUuid(p2)) break;
      await answer(await photoValueAction(s, p1, p2, messageId));
      return `cb:value_${p1}`;
    }
    case 'ml': {
      if (!p1 || !isUuid(p2)) break;
      await once(() => mealAction(s, p1, p2, messageId));
      return `cb:meal_${p1}`;
    }
    case 'ntf':
      await answer(await notificationsAction(s, p1 === 'on', messageId));
      return `cb:ntf_${p1}`;
    case 'unlink':
      await answer(await unlinkAction(s, p1 ?? 'no', messageId));
      return `cb:unlink_${p1}`;
  }
  await answer('Кнопка устарела');
  return 'cb:unknown';
}
