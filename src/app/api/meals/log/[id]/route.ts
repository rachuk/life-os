import { AppError, param, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { isUuid } from '@/server/db';
import { undoMealLog } from '@/server/services/meals';

/** «Отменить» after a meal answer: removes the log and reopens the event it settled. 404 if already gone. */
export const DELETE = userRoute(async ({ user, params }) => {
  const id = param(params, 'id');
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Отметка уже удалена', 404);
  return inUser(user.id, async (tx, ctx) => {
    await undoMealLog(tx, ctx, now(), id, 'web');
    return { ok: true };
  });
});
