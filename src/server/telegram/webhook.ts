import { createHash, timingSafeEqual } from 'node:crypto';
import { env } from '../env';
import { handleUpdate } from './handler';
import { isUpdate } from './types';

/**
 * Webhook request handling (PRD §12.4, NT-06/NT-07), kept outside the route file so tests can
 * call it with an inline scheduler. Telegram gets 200 as soon as the update is accepted; the
 * work runs after the response (`after()` in the route).
 */

const MAX_BODY = 1024 * 1024;

const json = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } });

/** Constant-time comparison of the secret header (hashing first equalises lengths). */
export function secretMatches(given: string | null, expected: string): boolean {
  if (!given) return false;
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

export async function handleWebhookRequest(req: Request, schedule: (task: () => Promise<unknown>) => void): Promise<Response> {
  const e = env();
  if (!e.ENABLE_TELEGRAM || !e.TELEGRAM_BOT_TOKEN) {
    return json(503, {
      code: 'TELEGRAM_NOT_CONFIGURED',
      message: 'Telegram-бот не подключён: не задан TELEGRAM_BOT_TOKEN (или ENABLE_TELEGRAM=false). Веб-приложение работает без него.',
    });
  }
  if (!e.TELEGRAM_WEBHOOK_SECRET) {
    return json(503, {
      code: 'TELEGRAM_WEBHOOK_SECRET_MISSING',
      message: 'Не задан TELEGRAM_WEBHOOK_SECRET — webhook отключён. Задай секрет (pnpm bot:webhook set) или используй pnpm bot:poll.',
    });
  }
  if (!secretMatches(req.headers.get('x-telegram-bot-api-secret-token'), e.TELEGRAM_WEBHOOK_SECRET)) {
    return json(401, { code: 'UNAUTHORIZED', message: 'Неверный секрет webhook' });
  }
  const len = Number(req.headers.get('content-length') ?? 0);
  if (len > MAX_BODY) return json(413, { code: 'TOO_LARGE', message: 'Слишком большой запрос' });
  let update: unknown;
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return json(413, { code: 'TOO_LARGE', message: 'Слишком большой запрос' });
    update = JSON.parse(text);
  } catch {
    return json(400, { code: 'BAD_JSON', message: 'Некорректное тело запроса' });
  }
  if (!isUpdate(update)) return json(400, { code: 'BAD_UPDATE', message: 'Это не Telegram update' });
  schedule(() =>
    handleUpdate(update).catch((err) => {
      console.error('[telegram webhook]', err instanceof Error ? err.name : 'unknown');
    }),
  );
  return json(200, { ok: true });
}
