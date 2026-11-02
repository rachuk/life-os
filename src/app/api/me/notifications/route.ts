import { z } from 'zod';
import { isLocalTime } from '@/domain/time';
import { notificationPrefsSchema } from '@/domain/planner/prefs';
import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { audit } from '@/server/services/audit';
import { reconcileReminders } from '@/server/services/notifications';
import { loadContext } from '@/server/services/profile';
import { patchOf } from '@/lib/patch';

const schema = z.object({
  notifications: patchOf(notificationPrefsSchema).optional(),
  quietHours: z.object({ start: z.string().refine(isLocalTime), end: z.string().refine(isLocalTime) }).nullable().optional(),
});

/** Channel / repeat / limit / quiet-hours settings; reminders are re-reconciled immediately. */
export const PATCH = userRoute(async ({ req, user }) => {
  const input = await readJson(req, schema);
  return inUser(user.id, async (tx, ctx) => {
    if (input.notifications) {
      const next = notificationPrefsSchema.parse({ ...ctx.prefs.notifications, ...input.notifications });
      await tx`update routine_preferences set notification_preferences = ${tx.json(next as never)} where user_id = ${user.id}`;
    }
    if (input.quietHours !== undefined) {
      await tx`update profiles set quiet_hours = ${input.quietHours ? tx.json(input.quietHours) : null} where user_id = ${user.id}`;
    }
    await audit(tx, user.id, 'profile', user.id, 'notification_settings_updated', { keys: Object.keys(input.notifications ?? {}) });
    const fresh = await loadContext(tx, user.id);
    // cancel/recreate pending reminders under the new rules
    await tx`update notification_outbox set status = 'cancelled', cancel_reason = 'settings_changed'
             where user_id = ${user.id} and status = 'scheduled'`;
    const r = await reconcileReminders(tx, fresh, now());
    return { ok: true, reminders: r };
  });
});
