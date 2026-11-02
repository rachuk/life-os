import { after } from 'next/server';
import { handleWebhookRequest } from '@/server/telegram/webhook';

/**
 * Telegram webhook (PRD §12.4). Verifies X-Telegram-Bot-Api-Secret-Token (NT-06), answers 200
 * right away and processes the update after the response. 503 when the bot is not configured (NT-07).
 */
export async function POST(req: Request) {
  return handleWebhookRequest(req, (task) => after(task));
}
