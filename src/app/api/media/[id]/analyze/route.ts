import { isUuid } from '@/server/db';
import { notFound, param, userRoute } from '@/server/http';
import { now } from '@/server/context';
import { analyzeMedia } from '@/server/services/media';

/** AI reading of a weight/steps/meal photo → proposal only (needs_review). Never writes health data. */
export const POST = userRoute(async ({ user, params }) => {
  const id = param(params, 'id');
  if (!isUuid(id)) throw notFound('Запись о файле');
  return analyzeMedia(user.id, id, now());
});
