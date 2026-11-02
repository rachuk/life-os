import { z } from 'zod';
import { AppError, userRoute } from '@/server/http';
import { now } from '@/server/context';
import { IMAGE_MIME_TYPES, MEDIA_PURPOSES, maxUploadBytes, saveImage, serializeMedia, signMediaUrl } from '@/server/services/media';

const purposeSchema = z.enum(MEDIA_PURPOSES);

/**
 * Private image upload (PRD §11.1): multipart `file` + `purpose`. The image is re-encoded
 * (EXIF/GPS removed) and stored outside /public; body photos require opt-in (HEALTH-06).
 */
export const POST = userRoute(async ({ req, user }) => {
  const limit = maxUploadBytes();
  if (Number(req.headers.get('content-length') ?? 0) > limit + 256 * 1024) {
    throw new AppError('FILE_TOO_LARGE', `Файл больше ${Math.round(limit / 1048576)} МБ`, 413);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError('BAD_FORM', 'Ожидается форма с полем file', 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError('NO_FILE', 'Выбери фото', 400, undefined, { file: ['Выбери фото'] });
  const purpose = purposeSchema.safeParse(form.get('purpose'));
  if (!purpose.success) throw new AppError('VALIDATION_ERROR', 'Выбери назначение фото', 422, undefined, { purpose: ['Выбери назначение'] });
  if (file.size > limit) throw new AppError('FILE_TOO_LARGE', `Файл больше ${Math.round(limit / 1048576)} МБ`, 413);
  const type = (file.type || '').toLowerCase();
  // some browsers send an empty type for HEIC; the content is sniffed by the decoder anyway
  if (type && !(IMAGE_MIME_TYPES as readonly string[]).includes(type)) {
    throw new AppError('UNSUPPORTED_IMAGE', 'Поддерживаются JPEG, PNG, WebP и HEIC', 415);
  }
  const media = await saveImage(user.id, now(), { data: Buffer.from(await file.arrayBuffer()), purpose: purpose.data, source: 'web' });
  return { media: serializeMedia(media), file: signMediaUrl(media.id, user.id) };
});
