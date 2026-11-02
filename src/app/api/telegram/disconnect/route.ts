import { userRoute } from '@/server/http';
import { now } from '@/server/context';
import { disconnectTelegram } from '@/server/telegram/pairing';
import { telegramClient } from '@/server/telegram/api';

export const POST = userRoute(async ({ user }) => {
  const { chatId } = await disconnectTelegram(user.id, now(), 'web');
  if (chatId) {
    // best effort: tell the chat it no longer receives anything
    await telegramClient()
      ?.sendMessage(chatId, 'Чат отвязан от Life OS в настройках приложения. Подключить снова можно там же.')
      .catch(() => {});
  }
  return { ok: true, disconnected: !!chatId };
});
