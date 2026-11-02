import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DateTime } from 'luxon';
import sharp from 'sharp';
import { z } from 'zod';
import { evaluateMeal, evaluateSteps, evaluateWeight, type MediaProposal } from '@/domain/media/evaluate';
import { isLocalDate, localDateOf, timeToMinutes, localTimeOf, type LocalDate } from '@/domain/time';
import { MEAL_SLOT_LABELS, mealSlotOfKind, type MealSlot } from '@/domain/types';
import { withUser, type Tx } from '../db';
import { env, mediaSigningSecret } from '../env';
import { AppError, notFound } from '../http';
import { aiProvider, AIError } from '../ai/provider';
import { assertAIBudget, recordAIUsage } from '../ai/budget';
import { deleteStoredFile, getStoredFile, putStoredFile } from '../storage/files';
import { audit } from './audit';
import { addMeasurement, serializeMeasurement } from './health';
import { logMeal } from './meals';
import { dayEvents } from './planning';
import { loadContext, type PrivacySettings, type UserContext } from './profile';

/**
 * Private media (PRD §11, §19): images are re-encoded (EXIF/GPS stripped), stored outside /public,
 * served only to the owner with a short-lived signed URL, analysed by AI only with consent and
 * never written into health data without an explicit confirmation.
 */

export const MEDIA_PURPOSES = ['weight_photo', 'steps_screenshot', 'meal_photo', 'progress_photo', 'receipt', 'other'] as const;
export type MediaPurpose = (typeof MEDIA_PURPOSES)[number];
export const PURPOSE_LABELS: Record<MediaPurpose, string> = {
  weight_photo: 'Вес',
  steps_screenshot: 'Шаги',
  meal_photo: 'Еда',
  progress_photo: 'Фото прогресса',
  receipt: 'Чек',
  other: 'Другое',
};

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'] as const;
export const SIGNED_URL_TTL_SECONDS = 300;
const MAX_INPUT_PIXELS = 50_000_000; // decompression-bomb guard
const MAX_EDGE = 2560;
const PENDING_RETENTION_DAYS = 1;

export function maxUploadBytes(): number {
  return env().MAX_UPLOAD_MB * 1024 * 1024;
}

export interface MediaRow {
  id: string;
  userId: string;
  kind: MediaPurpose | 'voice';
  storagePath: string;
  mime: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  sha256: string | null;
  captureDate: string | null;
  privacyLevel: 'private' | 'sensitive';
  consentSnapshot: Record<string, unknown>;
  retentionUntil: Date | null;
  processingStatus: string;
  source: string;
  createdAt: Date;
}

/** Client-safe view: never exposes the storage path. */
export function serializeMedia(m: MediaRow) {
  return {
    id: m.id,
    kind: m.kind,
    mime: m.mime,
    sizeBytes: m.sizeBytes,
    width: m.width,
    height: m.height,
    captureDate: m.captureDate,
    privacyLevel: m.privacyLevel,
    retentionUntil: m.retentionUntil?.toISOString() ?? null,
    processingStatus: m.processingStatus,
    source: m.source,
    createdAt: m.createdAt.toISOString(),
  };
}
export type SerializedMedia = ReturnType<typeof serializeMedia>;

const days = (now: DateTime, n: number) => now.plus({ days: n }).toJSDate();

/**
 * Retention per privacy settings (PRD §19.2): meal photos N days; weight/steps screenshots N days
 * (0 = delete right after the value is confirmed, with a 1-day cap if never confirmed);
 * body photos only with opt-in and kept until the user deletes them; raw voice 1 day.
 */
export function retentionFor(purpose: MediaPurpose | 'voice' | 'pending', privacy: PrivacySettings, now: DateTime): Date | null {
  switch (purpose) {
    case 'progress_photo':
      return null;
    case 'meal_photo':
      return days(now, privacy.mealPhotoRetentionDays);
    case 'voice':
      return days(now, privacy.storeVoiceAudio ? 30 : 1);
    case 'pending':
      return days(now, PENDING_RETENTION_DAYS);
    default:
      return days(now, privacy.screenshotRetentionDays > 0 ? privacy.screenshotRetentionDays : PENDING_RETENTION_DAYS);
  }
}

function consentSnapshot(privacy: PrivacySettings, now: DateTime) {
  return {
    bodyPhotosOptIn: privacy.bodyPhotosOptIn,
    aiImagesConsent: privacy.aiImagesConsent,
    aiVoiceConsent: privacy.aiVoiceConsent,
    storeVoiceAudio: privacy.storeVoiceAudio,
    recordedAt: now.toISO(),
  };
}

const bodyOptInError = (deleted: boolean) =>
  new AppError(
    'BODY_PHOTOS_OPT_IN_REQUIRED',
    `Фото тела сохраняются только с отдельным согласием: Настройки → Приватность → «Фото прогресса».${deleted ? ' Файл удалён' : ' Файл не сохранён'} и никуда не отправлялся.`,
    403,
  );

// ---------------------------------------------------------------------------
// image processing
// ---------------------------------------------------------------------------
const HEIC_MESSAGE =
  'Формат HEIC сервер прочитать не может. Сохрани фото как JPEG (iPhone: Настройки → Камера → Форматы → «Наиболее совместимый») или отправь скриншот.';

/**
 * Decode → auto-orient (EXIF rotation) → limit size → re-encode as JPEG. Re-encoding drops every
 * metadata block (EXIF, GPS, XMP, ICC), which is how geolocation is removed (PRD §11.6, §19.1).
 */
export async function normalizeImage(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  if (!input.length) throw new AppError('EMPTY_FILE', 'Файл пустой', 400);
  let format: string | undefined;
  try {
    format = (await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS }).metadata()).format;
  } catch {
    throw new AppError('UNSUPPORTED_IMAGE', 'Не удалось прочитать изображение. Поддерживаются JPEG, PNG и WebP (HEIC — если сервер умеет его читать).', 415);
  }
  if (!format || !['jpeg', 'png', 'webp', 'heif'].includes(format)) {
    throw new AppError('UNSUPPORTED_IMAGE', 'Этот формат не поддерживается. Отправь JPEG, PNG или WebP.', 415);
  }
  try {
    const { data, info } = await sharp(input, { limitInputPixels: MAX_INPUT_PIXELS })
      .rotate()
      .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer({ resolveWithObject: true });
    return { data, width: info.width, height: info.height };
  } catch {
    if (format === 'heif') throw new AppError('HEIC_UNSUPPORTED', HEIC_MESSAGE, 415);
    throw new AppError('UNSUPPORTED_IMAGE', 'Изображение повреждено или слишком большое. Попробуй другое фото.', 415);
  }
}

export function storagePathFor(userId: string, now: DateTime, tz: string, id: string, ext: string): string {
  const local = now.setZone(tz);
  return `${userId}/${local.toFormat('yyyy')}/${local.toFormat('MM')}/${id}.${ext}`;
}

async function loadCtx(userId: string): Promise<UserContext> {
  return withUser(userId, (tx) => loadContext(tx, userId));
}

/**
 * Store an image privately. `purpose: 'pending'` is used by Telegram before the user picked what
 * the photo is: it is kept as sensitive, for at most a day, and never analysed until a purpose is set.
 */
export async function saveImage(
  userId: string,
  now: DateTime,
  input: { data: Buffer; purpose: MediaPurpose | 'pending'; source: 'web' | 'telegram' },
): Promise<MediaRow> {
  const ctx = await loadCtx(userId);
  if (input.purpose === 'progress_photo' && !ctx.privacy.bodyPhotosOptIn) throw bodyOptInError(false);
  if (input.data.length > maxUploadBytes()) {
    throw new AppError('FILE_TOO_LARGE', `Файл больше ${env().MAX_UPLOAD_MB} МБ`, 413);
  }
  const img = await normalizeImage(input.data);
  const id = randomUUID();
  const path = storagePathFor(userId, now, ctx.tz, id, 'jpg');
  await putStoredFile(path, img.data);
  const kind: MediaPurpose = input.purpose === 'pending' ? 'other' : input.purpose;
  const sensitive = input.purpose === 'pending' || input.purpose === 'progress_photo';
  try {
    return await withUser(userId, async (tx) => {
      const [row] = await tx<MediaRow[]>`
        insert into media_assets (id, user_id, kind, storage_path, mime, size_bytes, width, height, sha256, capture_date,
                                  privacy_level, consent_snapshot, retention_until, processing_status, source)
        values (${id}, ${userId}, ${kind}, ${path}, 'image/jpeg', ${img.data.length}, ${img.width}, ${img.height},
                ${createHash('sha256').update(img.data).digest('hex')}, ${localDateOf(now, ctx.tz)},
                ${sensitive ? 'sensitive' : 'private'}, ${tx.json(consentSnapshot(ctx.privacy, now) as never)},
                ${retentionFor(input.purpose, ctx.privacy, now)}, ${input.purpose === 'pending' ? 'received' : 'stored_private'}, ${input.source})
        returning *`;
      await audit(tx, userId, 'media_asset', id, 'stored', { kind, source: input.source }, input.source);
      return row!;
    });
  } catch (e) {
    await deleteStoredFile(path).catch(() => {});
    throw e;
  }
}

/** Raw voice is stored only for the short processing window (or longer with explicit consent). */
export async function saveVoice(userId: string, now: DateTime, input: { data: Buffer; mime: string; ext: string; source: 'web' | 'telegram' }): Promise<MediaRow> {
  const ctx = await loadCtx(userId);
  const id = randomUUID();
  const path = storagePathFor(userId, now, ctx.tz, id, input.ext.replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'bin');
  await putStoredFile(path, input.data);
  try {
    return await withUser(userId, async (tx) => {
      const [row] = await tx<MediaRow[]>`
        insert into media_assets (id, user_id, kind, storage_path, mime, size_bytes, capture_date, privacy_level,
                                  consent_snapshot, retention_until, processing_status, source)
        values (${id}, ${userId}, 'voice', ${path}, ${input.mime}, ${input.data.length}, ${localDateOf(now, ctx.tz)}, 'sensitive',
                ${tx.json(consentSnapshot(ctx.privacy, now) as never)}, ${retentionFor('voice', ctx.privacy, now)}, 'processing', ${input.source})
        returning *`;
      return row!;
    });
  } catch (e) {
    await deleteStoredFile(path).catch(() => {});
    throw e;
  }
}

export async function getMedia(tx: Tx, userId: string, id: string): Promise<MediaRow> {
  const [m] = await tx<MediaRow[]>`select * from media_assets where id = ${id} and user_id = ${userId}`;
  if (!m) throw notFound('Запись о файле');
  return m;
}

/** Set what a (Telegram) photo is. Body photos without opt-in are deleted, not kept (HEALTH-06). */
export async function setMediaPurpose(userId: string, id: string, purpose: MediaPurpose, now: DateTime, source: 'web' | 'telegram' = 'telegram'): Promise<MediaRow> {
  const ctx = await loadCtx(userId);
  const current = await withUser(userId, (tx) => getMedia(tx, userId, id));
  if (current.kind === 'voice') throw new AppError('BAD_MEDIA', 'Это не фото', 422);
  if (purpose === 'progress_photo' && !ctx.privacy.bodyPhotosOptIn) {
    await deleteMedia(userId, id, source);
    throw bodyOptInError(true);
  }
  if (['logged', 'confirmed'].includes(current.processingStatus)) {
    throw new AppError('ALREADY_USED', 'Это фото уже использовано — назначение не меняется', 409);
  }
  return withUser(userId, async (tx) => {
    const [row] = await tx<MediaRow[]>`
      update media_assets set kind = ${purpose}, privacy_level = ${purpose === 'progress_photo' ? 'sensitive' : 'private'},
        retention_until = ${retentionFor(purpose, ctx.privacy, now)}, processing_status = 'stored_private',
        consent_snapshot = ${tx.json(consentSnapshot(ctx.privacy, now) as never)}
      where id = ${id} and user_id = ${userId} returning *`;
    if (!row) throw notFound('Запись о файле');
    await audit(tx, userId, 'media_asset', id, 'purpose_set', { kind: purpose }, source);
    return row;
  });
}

/** Removes the stored file first, then the row (SEC-04). Interpretations cascade; measurements keep their value. */
export async function deleteMedia(userId: string, id: string, source = 'web'): Promise<void> {
  await withUser(userId, async (tx) => {
    const [m] = await tx<{ storagePath: string; kind: string }[]>`
      select storage_path, kind from media_assets where id = ${id} and user_id = ${userId} for update`;
    if (!m) throw notFound('Запись о файле');
    await deleteStoredFile(m.storagePath);
    await tx`delete from media_assets where id = ${id} and user_id = ${userId}`;
    await audit(tx, userId, 'media_asset', id, 'deleted', { kind: m.kind }, source);
  });
}

export async function readMediaFile(userId: string, id: string): Promise<{ data: Buffer; mime: string; kind: string }> {
  const m = await withUser(userId, (tx) => getMedia(tx, userId, id));
  try {
    return { data: await getStoredFile(m.storagePath), mime: m.mime, kind: m.kind };
  } catch {
    throw notFound('Запись о файле');
  }
}

// ---------------------------------------------------------------------------
// signed URLs (SEC-03): HMAC over id + owner + expiry; the file route also requires the owner's session
// ---------------------------------------------------------------------------
function signature(id: string, userId: string, exp: number): string {
  return createHmac('sha256', mediaSigningSecret()).update(`${id}.${userId}.${exp}`).digest('base64url');
}

export function signMediaUrl(id: string, userId: string, nowMs = Date.now()): { url: string; expiresAt: string } {
  const exp = Math.floor(nowMs / 1000) + SIGNED_URL_TTL_SECONDS;
  return { url: `/api/media/${id}/file?exp=${exp}&sig=${signature(id, userId, exp)}`, expiresAt: new Date(exp * 1000).toISOString() };
}

export function verifyMediaSignature(id: string, userId: string, exp: string | null, sig: string | null, nowMs = Date.now()): boolean {
  if (!exp || !sig || !/^\d{1,12}$/.test(exp) || sig.length > 100) return false;
  const e = Number(exp);
  const nowS = Math.floor(nowMs / 1000);
  if (e < nowS || e > nowS + SIGNED_URL_TTL_SECONDS + 5) return false;
  const expected = Buffer.from(signature(id, userId, e));
  const given = Buffer.from(sig);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

// ---------------------------------------------------------------------------
// meal target: which planned meal a photo most likely belongs to
// ---------------------------------------------------------------------------
export interface MealTarget {
  eventId: string | null;
  slot: MealSlot;
  label: string;
  localDate: LocalDate;
}

export async function mealTargets(tx: Tx, ctx: UserContext, now: DateTime): Promise<{ options: MealTarget[]; suggested: MealTarget }> {
  const today = localDateOf(now, ctx.tz);
  const rows = (await dayEvents(tx, ctx, today)).filter((r) => mealSlotOfKind(r.kind) && !['completed', 'skipped', 'cancelled'].includes(r.status));
  const options: MealTarget[] = rows.map((r) => ({
    eventId: r.id,
    slot: mealSlotOfKind(r.kind)!,
    label: `${MEAL_SLOT_LABELS[mealSlotOfKind(r.kind)!]}, ${localTimeOf(r.startAt, ctx.tz)}`,
    localDate: today,
  }));
  const nowMs = now.toMillis();
  const near = rows
    .map((r) => ({ r, d: nowMs < r.startAt.getTime() ? r.startAt.getTime() - nowMs : Math.max(0, nowMs - r.endAt.getTime()) }))
    .filter((x) => x.d <= 3 * 3600_000)
    .sort((a, b) => a.d - b.d)[0];
  const fallbackSlot: MealSlot = (() => {
    const m = timeToMinutes(localTimeOf(now, ctx.tz));
    return m < 11 * 60 ? 'breakfast' : m < 16 * 60 ? 'lunch' : 'dinner';
  })();
  const suggested = near
    ? options.find((o) => o.eventId === near.r.id)!
    : { eventId: null, slot: fallbackSlot, label: MEAL_SLOT_LABELS[fallbackSlot], localDate: today };
  return { options, suggested };
}

// ---------------------------------------------------------------------------
// AI analysis → proposal (never writes measurements or meal logs)
// ---------------------------------------------------------------------------
const OPERATION: Partial<Record<MediaRow['kind'], 'analyze_weight' | 'analyze_steps' | 'analyze_meal'>> = {
  weight_photo: 'analyze_weight',
  steps_screenshot: 'analyze_steps',
  meal_photo: 'analyze_meal',
};

export interface AnalysisResult {
  interpretationId: string;
  proposal: MediaProposal;
}

export function aiImagesAvailable(privacy: PrivacySettings): { available: boolean; reason: 'not_configured' | 'no_consent' | null } {
  if (!aiProvider().canSee()) return { available: false, reason: 'not_configured' };
  if (!privacy.aiImagesConsent) return { available: false, reason: 'no_consent' };
  return { available: true, reason: null };
}

export async function analyzeMedia(userId: string, id: string, now: DateTime): Promise<AnalysisResult> {
  const { ctx, media, plannedMeal } = await withUser(userId, async (tx) => {
    const ctx = await loadContext(tx, userId);
    const media = await getMedia(tx, userId, id);
    let plannedMeal: string | null = null;
    if (media.kind === 'meal_photo') {
      const { suggested } = await mealTargets(tx, ctx, now);
      const [p] = await tx<{ description: string | null; title: string | null }[]>`
        select e.description, t.title from meal_plan_entries e left join meal_templates t on t.id = e.template_id
        where e.user_id = ${userId} and e.local_date = ${suggested.localDate} and e.meal_slot = ${suggested.slot} limit 1`;
      plannedMeal = p?.title ?? p?.description ?? null;
    }
    return { ctx, media, plannedMeal };
  });
  if (media.kind === 'progress_photo') throw new AppError('AI_NOT_ALLOWED', 'Фото тела не отправляются в ИИ.', 403);
  const operation = OPERATION[media.kind];
  if (!operation) throw new AppError('AI_NOT_SUPPORTED', 'Для этого типа файла распознавание не выполняется.', 422);
  const ai = aiProvider();
  if (!ai.canSee()) throw new AppError('AI_NOT_CONFIGURED', 'Распознавание фото не подключено — введи значение вручную.', 503);
  if (!ctx.privacy.aiImagesConsent) {
    throw new AppError('AI_CONSENT_REQUIRED', 'Отправка фото в ИИ выключена в настройках приватности. Введи значение вручную или включи согласие.', 403);
  }
  try {
    await assertAIBudget(userId);
  } catch (e) {
    if (e instanceof AIError) throw new AppError('AI_BUDGET', e.message, 429);
    throw e;
  }
  const image = await getStoredFile(media.storagePath).catch(() => {
    throw notFound('Запись о файле');
  });
  const today = localDateOf(now, ctx.tz);
  const imgCtx = { todayLocal: today, plannedMeal, knownRestrictions: null };
  let raw: unknown;
  let proposal: MediaProposal;
  let confidence: number | null = null;
  try {
    if (operation === 'analyze_weight') {
      const r = await ai.analyzeWeight(image, media.mime, imgCtx);
      raw = r;
      confidence = r.confidence;
      proposal = evaluateWeight(r);
    } else if (operation === 'analyze_steps') {
      const r = await ai.analyzeSteps(image, media.mime, imgCtx);
      raw = r;
      confidence = r.confidence;
      proposal = evaluateSteps(r, today);
    } else {
      const r = await ai.analyzeMeal(image, media.mime, imgCtx);
      raw = r;
      confidence = r.detected.length ? Math.max(...r.detected.map((d) => d.confidence)) : null;
      proposal = evaluateMeal(r);
    }
  } catch (e) {
    const message = e instanceof AIError ? e.message : 'ИИ недоступен';
    await recordAIUsage(userId, ai.name, operation, false).catch(() => {});
    await withUser(userId, (tx) => tx`
      insert into ai_interpretations (user_id, media_id, operation, provider, model, needs_review, error)
      values (${userId}, ${id}, ${operation}, ${ai.name}, ${env().AI_VISION_MODEL ?? null}, false, ${e instanceof AIError ? e.code : 'ERROR'})`);
    throw new AppError('AI_FAILED', `${message}. Введи значение вручную.`, 502);
  }
  await recordAIUsage(userId, ai.name, operation, true).catch(() => {});
  const interpretationId = await withUser(userId, async (tx) => {
    const [row] = await tx<{ id: string }[]>`
      insert into ai_interpretations (user_id, media_id, operation, provider, model, structured_json, confidence, needs_review)
      values (${userId}, ${id}, ${operation}, ${ai.name}, ${env().AI_VISION_MODEL ?? null}, ${tx.json({ raw, proposal } as never)}, ${confidence}, true)
      returning id`;
    await tx`update media_assets set processing_status = 'proposed' where id = ${id} and user_id = ${userId} and processing_status not in ('logged', 'confirmed')`;
    return row!.id;
  });
  return { interpretationId, proposal };
}

export async function latestInterpretation(tx: Tx, userId: string, mediaId: string): Promise<AnalysisResult | null> {
  const [r] = await tx<{ id: string; structuredJson: { proposal?: MediaProposal } }[]>`
    select id, structured_json from ai_interpretations
    where user_id = ${userId} and media_id = ${mediaId} and error is null order by created_at desc limit 1`;
  return r?.structuredJson.proposal ? { interpretationId: r.id, proposal: r.structuredJson.proposal } : null;
}

// ---------------------------------------------------------------------------
// confirmation → existing measurement / meal services, with provenance
// ---------------------------------------------------------------------------
export const mediaConfirmSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('measurement'),
    metricType: z.enum(['weight', 'steps']),
    value: z.number().finite(),
    localDate: z.string().refine(isLocalDate, 'Дата YYYY-MM-DD'),
    replace: z.boolean().default(false),
    interpretationId: z.string().uuid().nullable().optional(),
  }),
  z.object({
    kind: z.literal('meal'),
    consumptionStatus: z.enum(['all', 'part', 'replaced', 'not_eaten']),
    eventId: z.string().uuid().nullable().optional(),
    slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'post_workout']).optional(),
    localDate: z.string().refine(isLocalDate).optional(),
    description: z.string().trim().max(500).nullable().optional(),
    interpretationId: z.string().uuid().nullable().optional(),
  }),
]);
export type MediaConfirmInput = z.input<typeof mediaConfirmSchema>;

const PURPOSE_FOR: Record<'weight' | 'steps' | 'meal', MediaPurpose> = { weight: 'weight_photo', steps: 'steps_screenshot', meal: 'meal_photo' };

export async function confirmMedia(userId: string, id: string, now: DateTime, raw: MediaConfirmInput, source: 'web' | 'telegram' = 'web') {
  const input = mediaConfirmSchema.parse(raw);
  const result = await withUser(userId, async (tx) => {
    const ctx = await loadContext(tx, userId);
    const media = await getMedia(tx, userId, id);
    const expected = PURPOSE_FOR[input.kind === 'meal' ? 'meal' : input.metricType];
    if (media.kind !== expected) {
      throw new AppError('MEDIA_PURPOSE_MISMATCH', `Это фото отмечено как «${PURPOSE_LABELS[media.kind as MediaPurpose] ?? media.kind}» — выбери подходящее назначение`, 422);
    }
    let interp: { id: string; confidence: number | null; structuredJson: { proposal?: MediaProposal } } | undefined;
    if (input.interpretationId) {
      [interp] = await tx<NonNullable<typeof interp>[]>`
        select id, confidence, structured_json from ai_interpretations
        where id = ${input.interpretationId} and user_id = ${userId} and media_id = ${id}`;
    }
    if (input.kind === 'measurement') {
      const p = interp?.structuredJson.proposal;
      const aiValue = p && (p.kind === 'weight' || p.kind === 'steps') ? p.value : null;
      // the AI confidence is kept only when the user accepted the AI's own number; a corrected value is manual
      const accepted = aiValue !== null && Math.abs(aiValue - input.value) < 1e-9;
      const m = await addMeasurement(tx, ctx, now, {
        metricType: input.metricType,
        value: input.value,
        localDate: input.localDate,
        sourceType: input.metricType === 'weight' ? 'photo' : 'screenshot',
        sourceMediaId: id,
        aiConfidence: accepted ? (interp?.confidence ?? null) : null,
        replace: input.replace,
        notes: null,
      });
      if (interp) {
        await tx`update ai_interpretations set needs_review = false,
                   confirmed_at = ${accepted ? now.toJSDate() : null}, rejected_at = ${accepted ? null : now.toJSDate()}
                 where id = ${interp.id}`;
      }
      await tx`update media_assets set processing_status = 'logged' where id = ${id}`;
      await audit(tx, userId, 'media_asset', id, 'confirmed', { metric: input.metricType, aiAccepted: accepted }, source);
      return { kind: 'measurement' as const, measurement: serializeMeasurement(m), purge: ctx.privacy.screenshotRetentionDays === 0 };
    }
    let eventId = input.eventId ?? null;
    let slot = input.slot;
    if (!eventId && !slot) {
      const { suggested } = await mealTargets(tx, ctx, now);
      eventId = suggested.eventId;
      slot = suggested.slot;
    }
    const log = await logMeal(
      tx,
      ctx,
      now,
      { eventId, slot, localDate: input.localDate, consumptionStatus: input.consumptionStatus, description: input.description ?? null, drinks: [], mediaId: id },
      source,
    );
    if (interp) await tx`update ai_interpretations set needs_review = false, confirmed_at = ${now.toJSDate()} where id = ${interp.id}`;
    await audit(tx, userId, 'media_asset', id, 'confirmed', { meal: log.mealSlot, status: input.consumptionStatus }, source);
    return { kind: 'meal' as const, mealLog: { id: log.id, slot: log.mealSlot, localDate: log.localDate, consumptionStatus: log.consumptionStatus }, purge: false };
  });
  let deleted = false;
  if (result.purge) {
    // "0 days" = keep the number, delete the screenshot right after confirmation (PRD §19.2)
    await deleteMedia(userId, id, source).catch(() => {});
    deleted = true;
  }
  return { ...result, fileDeleted: deleted };
}
