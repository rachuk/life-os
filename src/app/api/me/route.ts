import { integrationStatuses } from '@/server/env';
import { userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { contextToForm } from '@/server/services/profile';

export const GET = userRoute(async ({ user }) =>
  inUser(user.id, async (tx, ctx) => {
    const [tg] = await tx<{ username: string | null; connectedAt: Date; notificationEnabled: boolean }[]>`
      select username, connected_at, notification_enabled from telegram_connections where user_id = ${user.id} and is_active`;
    return {
      user: { id: user.id, email: user.email, displayName: ctx.profile.displayName },
      profile: { timezone: ctx.tz, locale: ctx.profile.locale, isOnboarded: ctx.profile.isOnboarded, quietHours: ctx.profile.quietHours },
      preferences: ctx.profile.isOnboarded ? contextToForm(ctx) : null,
      privacy: ctx.privacy,
      channels: { telegram: tg ? { username: tg.username, connectedAt: tg.connectedAt.toISOString(), notificationsEnabled: tg.notificationEnabled } : null },
      integrations: integrationStatuses(),
    };
  }),
);
