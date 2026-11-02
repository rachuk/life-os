import { isUuid } from '@/server/db';
import { notFound, param, readJson, userRoute } from '@/server/http';
import { now } from '@/server/context';
import { confirmMedia, mediaConfirmSchema } from '@/server/services/media';

/**
 * The user's confirmation of a photo-derived value: a measurement (with source photo/screenshot
 * and source_media_id) or a meal answer (Съел всё / Часть / Заменил / Не ел — HEALTH-03).
 */
export const POST = userRoute(async ({ req, user, params }) => {
  const id = param(params, 'id');
  if (!isUuid(id)) throw notFound('Запись о файле');
  const input = await readJson(req, mediaConfirmSchema);
  return confirmMedia(user.id, id, now(), input, 'web');
});
