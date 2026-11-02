import { createHash, randomBytes } from 'node:crypto';
import type { DateTime } from 'luxon';
import { withSystem, withUser } from '../db';
import { env } from '../env';
import { AppError } from '../http';
import { audit } from '../services/audit';
import { reconcileReminders } from '../services/notifications';
import { loadContext } from '../services/profile';

/**
 * Pairing (PRD §19.1): a one-time link token with a 10-minute TTL (only its sha256 is stored),
 * one chat per user and one user per chat, explicit disconnect. Chat → user routing is the only
 * place where the bot looks a user up without a session, and it never trusts anything but chat_id.
 */

export const LINK_TTL_MINUTES = 10;
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

export function telegramConfigured(): boolean {
  const e = env();
  return e.ENABLE_TELEGRAM && !!e.TELEGRAM_BOT_TOKEN && !!e.TELEGRAM_BOT_USERNAME;
}

const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export interface LinkStart {
  deepLink: string;
  command: string;
  botUsername: string;
  expiresAt: string;
}

export async function createLinkToken(userId: string, nowJs: Date = new Date()): Promise<LinkStart> {
  const e = env();
  if (!e.ENABLE_TELEGRAM) throw new AppError('TELEGRAM_DISABLED', 'Telegram-бот выключен настройкой ENABLE_TELEGRAM.', 503);
  if (!telegramConfigured()) {
    throw new AppError('TELEGRAM_NOT_CONFIGURED', 'Telegram не настроен на сервере. Напоминания приходят внутри приложения.', 503);
  }
  const token = randomBytes(24).toString('base64url'); // 32 chars, allowed in /start payloads
  const expiresAt = new Date(nowJs.getTime() + LINK_TTL_MINUTES * 60_000);
  await withSystem(async (tx) => {
    // only the latest link works
    await tx`delete from telegram_link_tokens where user_id = ${userId} and (used_at is null or expires_at < now() - interval '1 day')`;
    await tx`insert into telegram_link_tokens (user_id, token_hash, expires_at) values (${userId}, ${hashToken(token)}, ${expiresAt})`;
  });
  const bot = e.TELEGRAM_BOT_USERNAME!.replace(/^@/, '');
  return { deepLink: `https://t.me/${bot}?start=${token}`, command: `/start ${token}`, botUsername: bot, expiresAt: expiresAt.toISOString() };
}

export type ConsumeResult =
  | { status: 'linked'; userId: string }
  | { status: 'already'; userId: string }
  | { status: 'invalid' }
  | { status: 'chat_taken' };

export async function consumeLinkToken(
  token: string,
  chat: { chatId: number; telegramUserId: number; username: string | null },
): Promise<ConsumeResult> {
  if (!TOKEN_RE.test(token)) return { status: 'invalid' };
  return withSystem(async (tx) => {
    const [t] = await tx<{ id: string; userId: string }[]>`
      select t.id, t.user_id from telegram_link_tokens t join users u on u.id = t.user_id
      where t.token_hash = ${hashToken(token)} and t.used_at is null and t.expires_at > now() and u.disabled_at is null
      for update of t`;
    if (!t) return { status: 'invalid' as const };
    const [byChat] = await tx<{ userId: string; isActive: boolean }[]>`
      select user_id, is_active from telegram_connections where chat_id = ${chat.chatId}`;
    if (byChat && byChat.userId !== t.userId) return { status: 'chat_taken' as const };
    await tx`update telegram_link_tokens set used_at = now() where id = ${t.id}`;
    if (byChat?.isActive) return { status: 'already' as const, userId: t.userId };
    const [row] = await tx<{ id: string }[]>`
      insert into telegram_connections (user_id, chat_id, telegram_user_id, username, is_active, notification_enabled, connected_at)
      values (${t.userId}, ${chat.chatId}, ${chat.telegramUserId}, ${chat.username}, true, true, now())
      on conflict (user_id) do update set chat_id = excluded.chat_id, telegram_user_id = excluded.telegram_user_id,
        username = excluded.username, is_active = true, notification_enabled = true, connected_at = now(),
        pending_state = null, last_update_id = null
      returning id`;
    await audit(tx, t.userId, 'telegram_connection', row!.id, 'linked', {}, 'telegram');
    return { status: 'linked' as const, userId: t.userId };
  });
}

export interface ChatConnection {
  userId: string;
  chatId: number;
  telegramUserId: number;
  notificationEnabled: boolean;
}

/** Chat → user routing (system scope by design: there is no session in a Telegram update). */
export async function connectionForChat(chatId: number): Promise<ChatConnection | null> {
  const [c] = await withSystem((tx) => tx<ChatConnection[]>`
    select c.user_id, c.chat_id, c.telegram_user_id, c.notification_enabled
    from telegram_connections c join users u on u.id = c.user_id
    where c.chat_id = ${chatId} and c.is_active and u.disabled_at is null`);
  return c ?? null;
}

export async function disconnectTelegram(userId: string, now: DateTime, source: 'web' | 'telegram' = 'web'): Promise<{ chatId: number | null }> {
  return withUser(userId, async (tx) => {
    const [row] = await tx<{ id: string; chatId: number }[]>`
      delete from telegram_connections where user_id = ${userId} returning id, chat_id`;
    if (!row) return { chatId: null };
    await audit(tx, userId, 'telegram_connection', row.id, 'unlinked', {}, source);
    await reconcileReminders(tx, await loadContext(tx, userId), now);
    return { chatId: row.chatId };
  });
}

export async function setTelegramNotifications(userId: string, enabled: boolean, now: DateTime, source: 'web' | 'telegram' = 'web'): Promise<boolean> {
  return withUser(userId, async (tx) => {
    const rows = await tx`update telegram_connections set notification_enabled = ${enabled} where user_id = ${userId} and is_active returning id`;
    if (!rows.length) throw new AppError('TELEGRAM_NOT_LINKED', 'Telegram не привязан к аккаунту', 409);
    await audit(tx, userId, 'telegram_connection', null, enabled ? 'notifications_on' : 'notifications_off', {}, source);
    await reconcileReminders(tx, await loadContext(tx, userId), now);
    return enabled;
  });
}

/** The user blocked the bot: stop sending (keeps the link so unblocking + /start resumes). */
export async function markChatBlocked(chatId: number): Promise<void> {
  await withSystem((tx) => tx`update telegram_connections set notification_enabled = false where chat_id = ${chatId}`);
}
