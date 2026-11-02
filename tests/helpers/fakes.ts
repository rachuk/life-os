import sharp from 'sharp';
import type { AIProvider, ImageContext } from '@/server/ai/provider';
import { AIError } from '@/server/ai/provider';
import type { MealPhoto, StepsScreenshot, WeightPhoto } from '@/server/ai/schemas';
import type { InlineButton, TelegramClient } from '@/server/telegram/api';
import type { TgUpdate } from '@/server/telegram/types';

/** In-memory Telegram Bot API: records everything the bot sends; serves fake files. */
export class FakeTelegram implements TelegramClient {
  sent: { chatId: number; text: string; buttons?: InlineButton[][]; messageId: number }[] = [];
  edits: { chatId: number; messageId: number; text: string; buttons?: InlineButton[][] }[] = [];
  answers: { id: string; text?: string }[] = [];
  getFileCalls: string[] = [];
  files = new Map<string, { path: string; data: Buffer }>();
  private seq = 5000;

  async sendMessage(chatId: number, text: string, opts: { buttons?: InlineButton[][] } = {}) {
    const messageId = ++this.seq;
    this.sent.push({ chatId, text, buttons: opts.buttons, messageId });
    return { messageId };
  }
  async editMessageText(chatId: number, messageId: number, text: string, opts: { buttons?: InlineButton[][] } = {}) {
    this.edits.push({ chatId, messageId, text, buttons: opts.buttons });
  }
  async answerCallbackQuery(id: string, text?: string) {
    this.answers.push({ id, text });
  }
  async getFile(fileId: string) {
    this.getFileCalls.push(fileId);
    const f = this.files.get(fileId);
    if (!f) throw new Error('file not found');
    return { filePath: f.path, fileSize: f.data.length };
  }
  async downloadFile(filePath: string) {
    for (const f of this.files.values()) if (f.path === filePath) return f.data;
    throw new Error('no such file');
  }

  addFile(fileId: string, data: Buffer) {
    this.files.set(fileId, { path: `files/${fileId}`, data });
  }
  /** Everything shown to a chat (sent + edited), oldest first. */
  outputs(chatId: number): { text: string; buttons?: InlineButton[][]; messageId: number }[] {
    return [...this.sent.filter((m) => m.chatId === chatId), ...this.edits.filter((m) => m.chatId === chatId)];
  }
  lastSent(chatId: number) {
    return this.sent.filter((m) => m.chatId === chatId).at(-1);
  }
  lastEdit(chatId: number) {
    return this.edits.filter((m) => m.chatId === chatId).at(-1);
  }
  answersFor(cqId: string) {
    return this.answers.filter((a) => a.id === cqId);
  }
}

export function callbackDataOf(m: { buttons?: InlineButton[][] } | undefined): string[] {
  return (m?.buttons ?? []).flat().map((b) => b.callbackData ?? '');
}

export function findButton(m: { buttons?: InlineButton[][] } | undefined, prefix: string): string {
  const d = callbackDataOf(m).find((x) => x.startsWith(prefix));
  if (!d) throw new Error(`no button ${prefix} in ${JSON.stringify(callbackDataOf(m))}`);
  return d;
}

/** Update factories; each test file uses its own update_id range (bot_update_id is globally unique). */
export function updateFactory(start: number) {
  let id = start;
  let msg = 100;
  const chat = (chatId: number, type = 'private') => ({ id: chatId, type });
  return {
    nextId: () => ++id,
    text(chatId: number, text: string, opts: { type?: string; fromId?: number } = {}): TgUpdate {
      return { update_id: ++id, message: { message_id: ++msg, date: 1_793_000_000, chat: chat(chatId, opts.type), from: { id: opts.fromId ?? chatId, first_name: 'T' }, text } };
    },
    callback(chatId: number, data: string, messageId = 4242, text = 'Напоминание'): TgUpdate {
      const uid = ++id;
      return {
        update_id: uid,
        callback_query: { id: `cq-${uid}`, from: { id: chatId }, data, message: { message_id: messageId, date: 1_793_000_000, chat: chat(chatId), text } },
      };
    },
    photo(chatId: number, fileId: string): TgUpdate {
      return {
        update_id: ++id,
        message: { message_id: ++msg, date: 1_793_000_000, chat: chat(chatId), from: { id: chatId }, photo: [{ file_id: `${fileId}-small`, width: 90, height: 60 }, { file_id: fileId, width: 900, height: 600 }] },
      };
    },
    document(chatId: number, fileId: string, mime: string): TgUpdate {
      return { update_id: ++id, message: { message_id: ++msg, date: 1_793_000_000, chat: chat(chatId), from: { id: chatId }, document: { file_id: fileId, mime_type: mime, file_size: 1000 } } };
    },
    voice(chatId: number, fileId: string, duration = 5): TgUpdate {
      return { update_id: ++id, message: { message_id: ++msg, date: 1_793_000_000, chat: chat(chatId), from: { id: chatId }, voice: { file_id: fileId, duration, mime_type: 'audio/ogg' } } };
    },
  };
}

/** Scriptable AI provider: no network, records calls. */
export class FakeAI implements AIProvider {
  readonly name = 'fake-ai';
  see = false;
  hear = false;
  calls: string[] = [];
  transcript = 'купить молоко';
  weight: WeightPhoto | AIError = { readable: true, value: 53.2, unit: 'kg', confidence: 0.9, otherNumbersVisible: false, note: null };
  steps: StepsScreenshot | AIError = { readable: true, value: 8432, period: 'day', dateShown: 'Сегодня', dateIso: null, metric: 'steps', confidence: 0.9, note: null };
  meal: MealPhoto | AIError = {
    readable: true,
    detected: [
      { name: 'рис', confidence: 0.9 },
      { name: 'курица', confidence: 0.8 },
    ],
    possible: ['соус'],
    notVisible: ['масло при готовке'],
    portionNote: null,
    questions: ['Было ли масло?'],
    matchesPlan: 'unknown',
    note: null,
  };
  lastImageCtx: ImageContext | null = null;

  canTranscribe() {
    return this.hear;
  }
  canParse() {
    return false;
  }
  canSee() {
    return this.see;
  }
  async transcribe() {
    this.calls.push('transcribe');
    return { text: this.transcript, language: 'ru' };
  }
  async parseIntent(): Promise<never> {
    throw new AIError('NOT_CONFIGURED', 'not in tests');
  }
  private out<T>(v: T | AIError): T {
    if (v instanceof AIError) throw v;
    return v;
  }
  async analyzeWeight(_i: Buffer, _m: string, ctx: ImageContext) {
    this.calls.push('weight');
    this.lastImageCtx = ctx;
    return this.out(this.weight);
  }
  async analyzeSteps(_i: Buffer, _m: string, ctx: ImageContext) {
    this.calls.push('steps');
    this.lastImageCtx = ctx;
    return this.out(this.steps);
  }
  async analyzeMeal(_i: Buffer, _m: string, ctx: ImageContext) {
    this.calls.push('meal');
    this.lastImageCtx = ctx;
    return this.out(this.meal);
  }
  async weeklyInsights(): Promise<never> {
    throw new AIError('NOT_CONFIGURED', 'not in tests');
  }
}

/** A small real JPEG, optionally with EXIF (incl. GPS) and an orientation tag. */
export async function testJpeg(opts: { width?: number; height?: number; exif?: boolean; orientation?: number } = {}): Promise<Buffer> {
  let img = sharp({ create: { width: opts.width ?? 64, height: opts.height ?? 32, channels: 3, background: { r: 120, g: 140, b: 160 } } }).jpeg();
  if (opts.orientation) img = img.withMetadata({ orientation: opts.orientation });
  if (opts.exif) {
    img = img.withExif({
      IFD0: { Copyright: 'owner-secret', Artist: 'Test Person' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '38/1 42/1 0/1', GPSLongitudeRef: 'W', GPSLongitude: '9/1 8/1 0/1' },
    });
  }
  return img.toBuffer();
}

/** Minimal Ogg container bytes (magic "OggS"); content is irrelevant for the fake transcriber. */
export function fakeOgg(): Buffer {
  return Buffer.concat([Buffer.from('OggS'), Buffer.alloc(200, 1)]);
}
