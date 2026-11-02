import { z } from 'zod';
import { AppError, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { isLocalDate } from '@/domain/time';
import { isUuid } from '@/server/db';
import { checkinSchema, deleteCheckin, recordCheckin } from '@/server/services/habits';

/** Upsert a check-in: done / partial / skipped / exception (with reason). */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, checkinSchema);
  return inUser(user.id, async (tx, ctx) => ({ checkin: await recordCheckin(tx, ctx, now(), input, 'manual') }));
});

const deleteQuery = z.object({ habitId: z.string().refine(isUuid), localDate: z.string().refine(isLocalDate) });

/** Remove a check-in — the day becomes unknown again (not "missed"). */
export const DELETE = userRoute(async ({ user, url }) => {
  const q = deleteQuery.safeParse({ habitId: url.searchParams.get('habitId'), localDate: url.searchParams.get('localDate') });
  if (!q.success) throw new AppError('BAD_REQUEST', 'Нужны habitId и localDate', 400);
  return inUser(user.id, async (tx, ctx) => {
    await deleteCheckin(tx, ctx.userId, q.data.habitId, q.data.localDate);
    return { ok: true };
  });
});
