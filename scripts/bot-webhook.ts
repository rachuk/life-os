import { loadEnv } from './_env';

/**
 * Telegram webhook management:
 *   pnpm bot:webhook set     — register ${APP_URL}/api/telegram/webhook with TELEGRAM_WEBHOOK_SECRET
 *   pnpm bot:webhook delete  — remove the webhook (e.g. before pnpm bot:poll)
 *   pnpm bot:webhook info    — show the current registration and the last delivery error
 * Secrets are never printed.
 */
async function main() {
  loadEnv();
  const cmd = process.argv[2] ?? 'info';
  const { env } = await import('../src/server/env');
  const e = env();
  if (!e.TELEGRAM_BOT_TOKEN) {
    console.error('Не задан TELEGRAM_BOT_TOKEN (.env.local)');
    process.exit(1);
  }
  const { HttpTelegramClient } = await import('../src/server/telegram/api');
  const client = new HttpTelegramClient(e.TELEGRAM_BOT_TOKEN);

  if (cmd === 'set') {
    if (!e.TELEGRAM_WEBHOOK_SECRET || e.TELEGRAM_WEBHOOK_SECRET.length < 16) {
      console.error('Задай TELEGRAM_WEBHOOK_SECRET (минимум 16 символов A-Z a-z 0-9 _ -), например: openssl rand -hex 32');
      process.exit(1);
    }
    if (!/^[A-Za-z0-9_-]{1,256}$/.test(e.TELEGRAM_WEBHOOK_SECRET)) {
      console.error('TELEGRAM_WEBHOOK_SECRET может содержать только A-Z a-z 0-9 _ - (ограничение Telegram)');
      process.exit(1);
    }
    if (!e.APP_URL.startsWith('https://')) {
      console.error(`Telegram принимает webhook только по HTTPS. Сейчас APP_URL=${e.APP_URL}. Для локальной разработки используй pnpm bot:poll.`);
      process.exit(1);
    }
    const url = `${e.APP_URL.replace(/\/$/, '')}/api/telegram/webhook`;
    await client.setWebhook(url, e.TELEGRAM_WEBHOOK_SECRET);
    console.log(`✓ Webhook установлен: ${url}`);
  } else if (cmd === 'delete') {
    await client.deleteWebhook(false);
    console.log('✓ Webhook удалён');
  } else if (cmd === 'info') {
    const info = await client.getWebhookInfo();
    console.log(`URL: ${info.url || '(не установлен — работает только pnpm bot:poll)'}`);
    console.log(`Ожидают доставки: ${info.pending_update_count}`);
    if (info.last_error_date) {
      console.log(`Последняя ошибка: ${new Date(info.last_error_date * 1000).toISOString()} — ${info.last_error_message ?? ''}`);
    }
  } else {
    console.error('Использование: pnpm bot:webhook set|delete|info');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('bot:webhook failed:', (err as Error).message);
  process.exit(1);
});
