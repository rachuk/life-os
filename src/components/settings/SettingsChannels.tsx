import { PushSettings } from './PushSettings';
import { TelegramConnect } from './TelegramConnect';

/**
 * Telegram + web push blocks shown under «Уведомления» in settings. A channel the server is not set up
 * for has nothing to connect, so its block is left out — the channel switch above already says
 * «… не настроен на сервере».
 */
export function SettingsChannels({ telegram, push }: { telegram: boolean; push: boolean }) {
  if (!telegram && !push) return null;
  return (
    <div className="space-y-3">
      {telegram ? <TelegramConnect /> : null}
      {push ? <PushSettings /> : null}
    </div>
  );
}
