import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { integrationStatuses } from '@/server/env';
import { deliveryDiagnostics } from '@/server/services/notifications';
import { SettingsClient } from '@/components/settings/SettingsClient';
import { SettingsChannels } from '@/components/settings/SettingsChannels';

export const metadata = { title: 'Настройки' };

export default async function SettingsPage() {
  const user = await requirePageUser();
  const data = await inUser(user.id, async (tx, ctx) => ({
    email: user.email,
    privacy: ctx.privacy,
    notifications: ctx.prefs.notifications,
    quietHours: ctx.profile.quietHours,
    tz: ctx.tz,
    nowIso: now().toISO()!,
    diagnostics: (await deliveryDiagnostics(tx, user.id, 30)).map((d) => ({
      id: d.id,
      channel: d.channel,
      reminderType: d.reminderType,
      status: d.status,
      scheduledAt: d.scheduledAt.toISOString(),
      sentAt: d.sentAt?.toISOString() ?? null,
      attempts: d.attempts,
      lastError: d.lastError,
      cancelReason: d.cancelReason,
      title: d.payloadJson?.title ?? '',
    })),
  }));
  const integrations = integrationStatuses();
  const ready = (key: string) => integrations.some((i) => i.key === key && i.enabled && i.configured);
  return <SettingsClient {...data} integrations={integrations} channels={<SettingsChannels telegram={ready('telegram')} push={ready('web_push')} />} />;
}
