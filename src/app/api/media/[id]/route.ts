import { isUuid } from '@/server/db';
import { notFound, param, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { aiImagesAvailable, deleteMedia, getMedia, latestInterpretation, serializeMedia, signMediaUrl } from '@/server/services/media';

function mediaId(params: Record<string, string | string[] | undefined>): string {
  const id = param(params, 'id');
  if (!isUuid(id)) throw notFound('Запись о файле');
  return id;
}

/** Metadata + a fresh 5-minute signed URL + the last AI proposal (if any). */
export const GET = userRoute(async ({ user, params }) => {
  const id = mediaId(params);
  return inUser(user.id, async (tx, ctx) => {
    const m = await getMedia(tx, user.id, id);
    return {
      media: serializeMedia(m),
      file: m.kind === 'voice' ? null : signMediaUrl(m.id, user.id),
      analysis: await latestInterpretation(tx, user.id, m.id),
      aiImages: aiImagesAvailable(ctx.privacy),
    };
  });
});

/** SEC-04: deletes the stored file and the row; old signed links stop working immediately. */
export const DELETE = userRoute(async ({ user, params }) => {
  await deleteMedia(user.id, mediaId(params), 'web');
  return { ok: true };
});
