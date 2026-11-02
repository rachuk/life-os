import { PushSettings } from './PushSettings';
import { TelegramConnect } from './TelegramConnect';

/** Telegram + web push blocks shown under «Уведомления» in settings. */
export function SettingsChannels() {
  return (
    <div className="space-y-3">
      <TelegramConnect />
      <PushSettings />
    </div>
  );
}
