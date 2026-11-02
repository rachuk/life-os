import { env } from '../env';
import { AppError } from '../http';
import { aiProvider, AIError } from '../ai/provider';
import { assertAIBudget, recordAIUsage } from '../ai/budget';
import type { PrivacySettings } from './profile';

/**
 * Speech-to-text (PRD §11.7, §18.1 TranscribeVoice). Audio is processed in memory and handed to the
 * configured provider only with the user's consent; the web route never writes it to disk.
 */

export const AUDIO_LIMIT_MB = 20; // Telegram getFile limit; also below Whisper's 25 MB
export function maxAudioBytes(): number {
  return Math.min(env().MAX_UPLOAD_MB, AUDIO_LIMIT_MB) * 1024 * 1024;
}

export type AudioContainer = 'webm' | 'ogg' | 'mp4' | 'mp3' | 'wav';

/** Magic-byte sniffing: the declared MIME type alone is not trusted. */
export function sniffAudio(b: Buffer): AudioContainer | null {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'webm';
  if (b.toString('ascii', 0, 4) === 'OggS') return 'ogg';
  if (b.toString('ascii', 4, 8) === 'ftyp') return 'mp4';
  if (b.toString('ascii', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0)) return 'mp3';
  if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WAVE') return 'wav';
  return null;
}

const MIME_FOR: Record<AudioContainer, { mime: string; ext: string }> = {
  webm: { mime: 'audio/webm', ext: 'webm' },
  ogg: { mime: 'audio/ogg', ext: 'ogg' },
  mp4: { mime: 'audio/mp4', ext: 'm4a' },
  mp3: { mime: 'audio/mpeg', ext: 'mp3' },
  wav: { mime: 'audio/wav', ext: 'wav' },
};

export function audioFormat(b: Buffer): { container: AudioContainer; mime: string; ext: string } {
  const c = sniffAudio(b);
  if (!c) throw new AppError('UNSUPPORTED_AUDIO', 'Формат записи не поддерживается (нужен webm, ogg, mp4/m4a, mp3 или wav).', 415);
  return { container: c, ...MIME_FOR[c] };
}

export type VoiceAvailability = { available: true } | { available: false; code: 'AI_NOT_CONFIGURED' | 'AI_CONSENT_REQUIRED'; message: string };

export function voiceAvailability(privacy: PrivacySettings): VoiceAvailability {
  if (!aiProvider().canTranscribe()) {
    return {
      available: false,
      code: 'AI_NOT_CONFIGURED',
      message: 'Распознавание голоса не подключено. Можно продиктовать текст с клавиатуры (значок микрофона на клавиатуре iPhone).',
    };
  }
  if (!privacy.aiVoiceConsent) {
    return {
      available: false,
      code: 'AI_CONSENT_REQUIRED',
      message:
        'Распознавание голоса выключено в настройках приватности: запись обрабатывается внешним сервисом. Включи согласие или продиктуй текст с клавиатуры.',
    };
  }
  return { available: true };
}

/** Transcribe audio that the caller already validated for size; throws AppError with a readable message. */
export async function transcribeAudio(userId: string, privacy: PrivacySettings, data: Buffer, source: 'web' | 'telegram'): Promise<{ text: string; language: string | null }> {
  const av = voiceAvailability(privacy);
  if (!av.available) throw new AppError(av.code, av.message, av.code === 'AI_NOT_CONFIGURED' ? 503 : 403);
  if (!data.length) throw new AppError('EMPTY_FILE', 'Пустая запись', 400);
  if (data.length > maxAudioBytes()) throw new AppError('FILE_TOO_LARGE', `Запись больше ${Math.round(maxAudioBytes() / 1048576)} МБ — отправь короче или текстом.`, 413);
  const fmt = audioFormat(data);
  try {
    await assertAIBudget(userId);
  } catch (e) {
    if (e instanceof AIError) throw new AppError('AI_BUDGET', e.message, 429);
    throw e;
  }
  const ai = aiProvider();
  try {
    const r = await ai.transcribe(data, fmt.mime, `voice.${fmt.ext}`, null);
    await recordAIUsage(userId, ai.name, `transcribe_${source}`, true).catch(() => {});
    return r;
  } catch (e) {
    await recordAIUsage(userId, ai.name, `transcribe_${source}`, false).catch(() => {});
    const msg = e instanceof AIError ? e.message : 'Сервис распознавания недоступен';
    throw new AppError('TRANSCRIBE_FAILED', `${msg}. Отправь текстом.`, 502);
  }
}
