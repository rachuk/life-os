import { AppError, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { maxAudioBytes, transcribeAudio, voiceAvailability } from '@/server/services/voice';

/**
 * Voice → text for quick capture (PRD §11.7). The audio stays in memory only and is discarded
 * after the request. Not configured → 503 AI_NOT_CONFIGURED; no consent → 403 AI_CONSENT_REQUIRED.
 */
export const POST = userRoute(async ({ req, user }) => {
  const privacy = await inUser(user.id, async (_tx, ctx) => ctx.privacy);
  const av = voiceAvailability(privacy);
  if (!av.available) throw new AppError(av.code, av.message, av.code === 'AI_NOT_CONFIGURED' ? 503 : 403);
  const limit = maxAudioBytes();
  if (Number(req.headers.get('content-length') ?? 0) > limit + 256 * 1024) {
    throw new AppError('FILE_TOO_LARGE', `Запись больше ${Math.round(limit / 1048576)} МБ — запиши короче`, 413);
  }
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    throw new AppError('BAD_FORM', 'Ожидается форма с полем file', 400);
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw new AppError('NO_FILE', 'Нет записи', 400);
  if (file.size > limit) throw new AppError('FILE_TOO_LARGE', `Запись больше ${Math.round(limit / 1048576)} МБ — запиши короче`, 413);
  const type = (file.type || '').toLowerCase();
  if (type && !/^(audio|video)\/(webm|mp4|ogg|mpeg|wav|x-wav|x-m4a|m4a|aac)(;.*)?$/.test(type)) {
    throw new AppError('UNSUPPORTED_AUDIO', 'Формат записи не поддерживается', 415);
  }
  const r = await transcribeAudio(user.id, privacy, Buffer.from(await file.arrayBuffer()), 'web');
  return { text: r.text, language: r.language };
});
