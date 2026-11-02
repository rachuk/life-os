import { env } from '../env';

/**
 * Minimal Telegram Bot API client (fetch-based). Injected as an interface so tests can use a fake
 * and so the webhook/polling handlers and the reminder worker share one implementation.
 */
export interface InlineButton {
  text: string;
  callbackData?: string;
  url?: string;
}

export interface TelegramClient {
  sendMessage(chatId: number, text: string, opts?: { buttons?: InlineButton[][]; replyTo?: number }): Promise<{ messageId: number }>;
  editMessageText(chatId: number, messageId: number, text: string, opts?: { buttons?: InlineButton[][] }): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
  getFile(fileId: string): Promise<{ filePath: string; fileSize?: number }>;
  downloadFile(filePath: string): Promise<Buffer>;
  /** optional: "typing…" indicator while a slow step (transcription, analysis) runs */
  sendChatAction?(chatId: number, action: 'typing' | 'upload_photo'): Promise<void>;
}

/** Update types the bot handles; used by both webhook registration and long polling. */
export const ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'] as const;

export class TelegramApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function keyboard(buttons?: InlineButton[][]) {
  if (!buttons?.length) return undefined;
  return {
    inline_keyboard: buttons.map((row) =>
      row.map((b) => (b.url ? { text: b.text, url: b.url } : { text: b.text, callback_data: (b.callbackData ?? '').slice(0, 64) })),
    ),
  };
}

export class HttpTelegramClient implements TelegramClient {
  constructor(
    private token: string,
    private base = env().TELEGRAM_API_BASE,
  ) {}

  private async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 20000): Promise<T> {
    const res = await fetch(`${this.base}/bot${this.token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const json = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !json.ok) throw new TelegramApiError(res.status, `Telegram ${method}: ${json.description ?? res.status}`);
    return json.result as T;
  }

  async sendMessage(chatId: number, text: string, opts: { buttons?: InlineButton[][]; replyTo?: number } = {}) {
    const r = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard(opts.buttons),
      reply_parameters: opts.replyTo ? { message_id: opts.replyTo, allow_sending_without_reply: true } : undefined,
    });
    return { messageId: r.message_id };
  }

  async editMessageText(chatId: number, messageId: number, text: string, opts: { buttons?: InlineButton[][] } = {}) {
    await this.call('editMessageText', { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', reply_markup: keyboard(opts.buttons) ?? { inline_keyboard: [] } });
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string) {
    await this.call('answerCallbackQuery', { callback_query_id: callbackQueryId, text: text?.slice(0, 190) });
  }

  async getFile(fileId: string) {
    const r = await this.call<{ file_path: string; file_size?: number }>('getFile', { file_id: fileId });
    return { filePath: r.file_path, fileSize: r.file_size };
  }

  async downloadFile(filePath: string) {
    const res = await fetch(`${this.base}/file/bot${this.token}/${filePath}`, { signal: AbortSignal.timeout(30000) });
    if (!res.ok) throw new TelegramApiError(res.status, `Telegram file download: ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
  }

  async sendChatAction(chatId: number, action: 'typing' | 'upload_photo') {
    await this.call('sendChatAction', { chat_id: chatId, action }).catch(() => {});
  }

  async raw<T>(method: string, body: Record<string, unknown>) {
    return this.call<T>(method, body);
  }

  // --- bot administration (scripts/bot-poll.ts, scripts/bot-webhook.ts) ---
  async getMe() {
    return this.call<{ id: number; username?: string; first_name: string }>('getMe', {});
  }

  /** Long polling: the HTTP timeout must exceed the Telegram-side `timeout`. */
  async getUpdates(offset: number, timeoutSec = 50): Promise<unknown[]> {
    return this.call<unknown[]>('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ALLOWED_UPDATES }, (timeoutSec + 15) * 1000);
  }

  async setWebhook(url: string, secretToken: string) {
    return this.call<boolean>('setWebhook', { url, secret_token: secretToken, allowed_updates: ALLOWED_UPDATES, max_connections: 10 });
  }

  async deleteWebhook(dropPendingUpdates = false) {
    return this.call<boolean>('deleteWebhook', { drop_pending_updates: dropPendingUpdates });
  }

  async getWebhookInfo() {
    return this.call<{ url: string; pending_update_count: number; last_error_date?: number; last_error_message?: string; max_connections?: number }>(
      'getWebhookInfo',
      {},
    );
  }
}

let client: TelegramClient | null | undefined;
export function telegramClient(): TelegramClient | null {
  if (client !== undefined) return client;
  const e = env();
  client = e.ENABLE_TELEGRAM && e.TELEGRAM_BOT_TOKEN ? new HttpTelegramClient(e.TELEGRAM_BOT_TOKEN) : null;
  return client;
}
export function setTelegramClient(c: TelegramClient | null | undefined): void {
  client = c;
}
