import { loadEnv } from './_env';

/**
 * Telegram long polling for local development / servers without a public HTTPS URL:
 *   pnpm bot:poll
 * Deletes the webhook first (Telegram delivers updates either by webhook or by getUpdates, not both),
 * then feeds every update into the same handler the webhook uses. Ctrl+C to stop.
 */
async function main() {
  loadEnv();
  const { env } = await import('../src/server/env');
  const e = env();
  if (!e.ENABLE_TELEGRAM || !e.TELEGRAM_BOT_TOKEN) {
    console.error('Telegram не подключён: задай TELEGRAM_BOT_TOKEN (и TELEGRAM_BOT_USERNAME) в .env.local');
    process.exit(1);
  }
  const { HttpTelegramClient, setTelegramClient } = await import('../src/server/telegram/api');
  const { handleUpdate } = await import('../src/server/telegram/handler');
  const { closeDb } = await import('../src/server/db');
  const client = new HttpTelegramClient(e.TELEGRAM_BOT_TOKEN);
  setTelegramClient(client);

  const me = await client.getMe();
  if (e.TELEGRAM_BOT_USERNAME && me.username && me.username.toLowerCase() !== e.TELEGRAM_BOT_USERNAME.replace(/^@/, '').toLowerCase()) {
    console.warn(`! TELEGRAM_BOT_USERNAME=${e.TELEGRAM_BOT_USERNAME}, а токен принадлежит @${me.username} — ссылки подключения будут неверными`);
  }
  await client.deleteWebhook(false);
  console.log(`✓ @${me.username ?? me.first_name}: long polling запущен (webhook удалён). Ctrl+C — остановить.`);

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    console.log('\nОстанавливаю…');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let offset = 0;
  let backoff = 1000;
  while (!stopping) {
    try {
      const updates = (await client.getUpdates(offset, 50)) as { update_id: number }[];
      backoff = 1000;
      for (const u of updates) {
        offset = Math.max(offset, u.update_id + 1);
        const r = await handleUpdate(u, { client });
        // ids and statuses only — never message contents
        console.log(`update ${u.update_id}: ${r.status}${r.route ? ` (${r.route})` : ''}`);
      }
    } catch (err) {
      if (stopping) break;
      console.error(`getUpdates: ${(err as Error).message ?? 'error'} — повтор через ${backoff / 1000} с`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
  await closeDb();
}

main().catch((err) => {
  console.error('bot:poll failed:', (err as Error).message);
  process.exit(1);
});
