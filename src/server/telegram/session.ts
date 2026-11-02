import type { DateTime } from 'luxon';
import { withUser } from '../db';
import type { InlineButton, TelegramClient } from './api';
import { fit } from './format';

/** Everything a flow needs to talk to one paired chat on behalf of its user. */
export interface ChatSession {
  client: TelegramClient;
  chatId: number;
  userId: string;
  now: DateTime;
  updateId: number;
}

export async function reply(s: Pick<ChatSession, 'client' | 'chatId'>, text: string, buttons?: InlineButton[][]): Promise<number> {
  const r = await s.client.sendMessage(s.chatId, fit(text), { buttons });
  return r.messageId;
}

/** Edit a bot message in place; falls back to a new message when it can no longer be edited. */
export async function edit(s: Pick<ChatSession, 'client' | 'chatId'>, messageId: number | null | undefined, text: string, buttons?: InlineButton[][]): Promise<number> {
  if (messageId) {
    try {
      await s.client.editMessageText(s.chatId, messageId, fit(text), { buttons });
      return messageId;
    } catch (e) {
      // "message is not modified" means the text is already there
      if (/not modified/i.test((e as Error).message ?? '')) return messageId;
    }
  }
  return reply(s, text, buttons);
}

/**
 * One-shot inline buttons (NT-04): the first press of (chat, message, button) claims it; later
 * presses — even as new update_ids — get «Уже отмечено». The claim is released if the action fails.
 */
export async function claimButton(s: ChatSession, messageId: number, data: string): Promise<{ claimed: true; release: () => Promise<void> } | { claimed: false }> {
  const rows = await withUser(s.userId, (tx) => tx<{ id: string }[]>`
    insert into telegram_callback_actions (user_id, chat_id, message_id, data)
    values (${s.userId}, ${s.chatId}, ${messageId}, ${data})
    on conflict (chat_id, message_id, data) do nothing returning id`);
  const id = rows[0]?.id;
  if (!id) return { claimed: false };
  return {
    claimed: true,
    release: async () => {
      await withUser(s.userId, (tx) => tx`delete from telegram_callback_actions where id = ${id}`).catch(() => {});
    },
  };
}
