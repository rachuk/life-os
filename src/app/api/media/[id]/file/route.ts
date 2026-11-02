import { isUuid } from '@/server/db';
import { AppError, notFound, param, userRoute } from '@/server/http';
import { readMediaFile, verifyMediaSignature } from '@/server/services/media';

/**
 * SEC-03: a file is served only with BOTH the owner's session (userRoute) and a valid, unexpired
 * HMAC signature bound to this file and this user. Never cached by shared caches.
 */
export const GET = userRoute(async ({ user, params, url }) => {
  const id = param(params, 'id');
  if (!isUuid(id)) throw notFound('Запись о файле');
  if (!verifyMediaSignature(id, user.id, url.searchParams.get('exp'), url.searchParams.get('sig'))) {
    throw new AppError('BAD_SIGNATURE', 'Ссылка на файл недействительна или устарела', 403);
  }
  const f = await readMediaFile(user.id, id);
  return new Response(new Uint8Array(f.data), {
    headers: {
      'Content-Type': f.mime,
      'Content-Length': String(f.data.length),
      'Cache-Control': 'private, no-store, max-age=0',
      'Content-Disposition': 'inline',
      'Content-Security-Policy': "default-src 'none'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    },
  });
});
