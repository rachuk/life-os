import { AppError, param, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { isUuid } from '@/server/db';
import { deleteMeasurement } from '@/server/services/health';

export const DELETE = userRoute(async ({ user, params }) => {
  const id = param(params, 'id');
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Измерение не найдено', 404);
  return inUser(user.id, async (tx, ctx) => {
    await deleteMeasurement(tx, ctx.userId, id);
    return { ok: true };
  });
});
