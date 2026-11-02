import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DateTime } from 'luxon';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { AIError, setAIProvider } from '@/server/ai/provider';
import { withSystem, withUser } from '@/server/db';
import { env } from '@/server/env';
import { AppError } from '@/server/http';
import { updatePrivacy } from '@/server/services/profile';
import {
  analyzeMedia,
  confirmMedia,
  deleteMedia,
  readMediaFile,
  retentionFor,
  saveImage,
  signMediaUrl,
  verifyMediaSignature,
  SIGNED_URL_TTL_SECONDS,
} from '@/server/services/media';
import { transcribeAudio } from '@/server/services/voice';
import { privacySchema } from '@/server/services/profile';
import { FakeAI, fakeOgg, testJpeg } from '../helpers/fakes';
import { onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const SUNDAY = DateTime.fromISO('2026-11-01T20:00', { zone: tz }).toUTC();
const TUE_LUNCH = DateTime.fromISO('2026-11-03T13:10', { zone: tz }).toUTC();
const ai = new FakeAI();
let alice: string;
let bob: string;

const storageRoot = () => resolve(process.cwd(), env().STORAGE_DIR);
function filesOf(userId: string): string[] {
  const dir = join(storageRoot(), userId);
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.\w+$/.test(f));
}
async function pathOf(id: string): Promise<string | undefined> {
  const [r] = await withSystem((tx) => tx<{ storagePath: string }[]>`select storage_path from media_assets where id = ${id}`);
  return r?.storagePath;
}
async function appErr(p: Promise<unknown>): Promise<AppError> {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AppError);
  return e as AppError;
}
const measurementCount = (userId: string) =>
  withSystem(async (tx) => (await tx<{ n: number }[]>`select count(*)::int as n from health_measurements where user_id = ${userId}`)[0]!.n);

beforeAll(async () => {
  setAIProvider(ai);
  alice = await onboardUser('media-alice', SUNDAY);
  bob = await onboardUser('media-bob', SUNDAY);
});
afterAll(() => setAIProvider(null));
beforeEach(() => {
  ai.see = false;
  ai.hear = false;
  ai.calls = [];
});

describe('upload pipeline (PRD §11, §19.1)', () => {
  it('re-encodes to JPEG at <userId>/<yyyy>/<mm>/<uuid>.jpg and strips EXIF incl. GPS', async () => {
    const input = await testJpeg({ exif: true });
    expect((await sharp(input).metadata()).exif?.toString('latin1')).toContain('owner-secret');
    const m = await saveImage(alice, TUE_LUNCH, { data: input, purpose: 'weight_photo', source: 'web' });
    expect(m.mime).toBe('image/jpeg');
    expect(m.storagePath).toMatch(new RegExp(`^${alice}/2026/11/[0-9a-f-]{36}\\.jpg$`));
    expect(m.captureDate).toBe('2026-11-03');
    expect(m.consentSnapshot).toMatchObject({ bodyPhotosOptIn: false, aiImagesConsent: false });
    const f = await readMediaFile(alice, m.id);
    const meta = await sharp(f.data).metadata();
    expect(meta.format).toBe('jpeg');
    expect(meta.exif).toBeUndefined();
    expect(f.data.toString('latin1')).not.toContain('owner-secret');
  });

  it('applies the EXIF orientation before dropping metadata', async () => {
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg({ width: 64, height: 32, orientation: 6 }), purpose: 'other', source: 'web' });
    expect([m.width, m.height]).toEqual([32, 64]);
  });

  it('rejects data that is not an image with a clear 415', async () => {
    const before = filesOf(alice).length;
    const e = await appErr(saveImage(alice, TUE_LUNCH, { data: Buffer.from('%PDF-1.4 not an image'), purpose: 'other', source: 'web' }));
    expect(e.status).toBe(415);
    expect(e.message).toMatch(/JPEG/);
    expect(filesOf(alice).length).toBe(before);
  });

  it('retention follows the privacy settings', () => {
    const p = privacySchema.parse({ mealPhotoRetentionDays: 30, screenshotRetentionDays: 7 });
    const at = (d: Date | null) => (d ? Math.round((d.getTime() - TUE_LUNCH.toMillis()) / 86400_000) : null);
    expect(at(retentionFor('meal_photo', p, TUE_LUNCH))).toBe(30);
    expect(at(retentionFor('steps_screenshot', p, TUE_LUNCH))).toBe(7);
    expect(at(retentionFor('progress_photo', p, TUE_LUNCH))).toBeNull();
    expect(at(retentionFor('voice', p, TUE_LUNCH))).toBe(1);
    expect(at(retentionFor('steps_screenshot', { ...p, screenshotRetentionDays: 0 }, TUE_LUNCH))).toBe(1);
  });
});

describe('HEALTH-06: body photos only with opt-in, never to AI', () => {
  it('without opt-in a progress photo is refused and nothing is written', async () => {
    const files = filesOf(bob).length;
    const [{ n } = { n: 0 }] = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from media_assets where user_id = ${bob}`);
    const e = await appErr(saveImage(bob, TUE_LUNCH, { data: await testJpeg(), purpose: 'progress_photo', source: 'web' }));
    expect(e.status).toBe(403);
    expect(e.code).toBe('BODY_PHOTOS_OPT_IN_REQUIRED');
    expect(filesOf(bob).length).toBe(files);
    const [{ n: after } = { n: 0 }] = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from media_assets where user_id = ${bob}`);
    expect(after).toBe(n);
  });

  it('with opt-in it is stored as sensitive, kept until deleted, never analysed, and deletable', async () => {
    await withUser(alice, (tx) => updatePrivacy(tx, alice, { bodyPhotosOptIn: true, aiImagesConsent: true }));
    ai.see = true;
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'progress_photo', source: 'web' });
    expect(m.privacyLevel).toBe('sensitive');
    expect(m.retentionUntil).toBeNull();
    const e = await appErr(analyzeMedia(alice, m.id, TUE_LUNCH));
    expect(e.code).toBe('AI_NOT_ALLOWED');
    expect(ai.calls).toEqual([]);
    const abs = join(storageRoot(), (await pathOf(m.id))!);
    expect(existsSync(abs)).toBe(true);
    await deleteMedia(alice, m.id);
    expect(existsSync(abs)).toBe(false);
    await withUser(alice, (tx) => updatePrivacy(tx, alice, { bodyPhotosOptIn: false }));
  });
});

describe('SEC-03: signed URLs', () => {
  const id = '11111111-2222-4333-8444-555555555555';
  it('accepts only the owner, an untampered signature and an unexpired link', () => {
    const t0 = Date.parse('2026-11-03T12:00:00Z');
    const { url, expiresAt } = signMediaUrl(id, alice, t0);
    const q = new URL(url, 'http://x').searchParams;
    const exp = q.get('exp');
    const sig = q.get('sig');
    expect(Date.parse(expiresAt) - t0).toBe(SIGNED_URL_TTL_SECONDS * 1000);
    expect(verifyMediaSignature(id, alice, exp, sig, t0 + 1000)).toBe(true);
    expect(verifyMediaSignature(id, alice, null, null, t0)).toBe(false); // unsigned
    expect(verifyMediaSignature(id, bob, exp, sig, t0)).toBe(false); // someone else's session
    expect(verifyMediaSignature('11111111-2222-4333-8444-555555555556', alice, exp, sig, t0)).toBe(false); // other file
    expect(verifyMediaSignature(id, alice, exp, `${sig!.slice(0, -2)}AA`, t0)).toBe(false); // tampered
    expect(verifyMediaSignature(id, alice, String(Number(exp) + 600), sig, t0)).toBe(false); // extended expiry
    expect(verifyMediaSignature(id, alice, exp, sig, t0 + (SIGNED_URL_TTL_SECONDS + 1) * 1000)).toBe(false); // expired
  });
});

describe('SEC-04 / SEC-01: deletion and isolation', () => {
  it('another account cannot read or delete the file', async () => {
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'meal_photo', source: 'web' });
    expect((await appErr(readMediaFile(bob, m.id))).status).toBe(404);
    expect((await appErr(deleteMedia(bob, m.id))).status).toBe(404);
    const rows = await withUser(bob, (tx) => tx`select id from media_assets where id = ${m.id}`);
    expect(rows).toHaveLength(0);
    expect((await readMediaFile(alice, m.id)).data.length).toBeGreaterThan(0);
  });

  it('deleting removes the stored file and the row; the old signed link serves nothing', async () => {
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'meal_photo', source: 'web' });
    const abs = join(storageRoot(), m.storagePath);
    const { url } = signMediaUrl(m.id, alice);
    expect(existsSync(abs)).toBe(true);
    await deleteMedia(alice, m.id);
    expect(existsSync(abs)).toBe(false);
    expect(await pathOf(m.id)).toBeUndefined();
    const q = new URL(url, 'http://x').searchParams;
    expect(verifyMediaSignature(m.id, alice, q.get('exp'), q.get('sig'))).toBe(true); // signature alone is not enough…
    expect((await appErr(readMediaFile(alice, m.id))).status).toBe(404); // …the file is gone
  });
});

describe('analysis → proposal → explicit confirmation', () => {
  it('honest errors: not configured (503) and no consent (403)', async () => {
    const m = await saveImage(bob, TUE_LUNCH, { data: await testJpeg(), purpose: 'weight_photo', source: 'web' });
    expect((await appErr(analyzeMedia(bob, m.id, TUE_LUNCH))).code).toBe('AI_NOT_CONFIGURED');
    ai.see = true;
    expect((await appErr(analyzeMedia(bob, m.id, TUE_LUNCH))).code).toBe('AI_CONSENT_REQUIRED');
    expect(ai.calls).toEqual([]);
  });

  it('weight: a proposal is stored for review, nothing is written until confirmed', async () => {
    ai.see = true;
    ai.weight = { readable: true, value: 53.2, unit: 'kg', confidence: 0.86, otherNumbersVisible: true, note: null };
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'weight_photo', source: 'web' });
    const before = await measurementCount(alice);
    const r = await analyzeMedia(alice, m.id, TUE_LUNCH);
    expect(r.proposal).toMatchObject({ kind: 'weight', canSave: true, value: 53.2 });
    expect(r.proposal.kind === 'weight' && r.proposal.hints.join(' ')).toMatch(/другие числа/);
    const [interp] = await withSystem((tx) => tx<{ needsReview: boolean; confirmedAt: Date | null }[]>`
      select needs_review, confirmed_at from ai_interpretations where id = ${r.interpretationId}`);
    expect(interp).toMatchObject({ needsReview: true, confirmedAt: null });
    expect(await measurementCount(alice)).toBe(before);

    const c = await confirmMedia(alice, m.id, TUE_LUNCH, { kind: 'measurement', metricType: 'weight', value: 53.2, localDate: '2026-11-03', interpretationId: r.interpretationId });
    expect(c.kind).toBe('measurement');
    const [row] = await withSystem((tx) => tx<{ value: number; sourceType: string; sourceMediaId: string; aiConfidence: number }[]>`
      select value, source_type, source_media_id, ai_confidence from health_measurements where user_id = ${alice} and metric_type = 'weight' and local_date = '2026-11-03'`);
    expect(row).toMatchObject({ value: 53.2, sourceType: 'photo', sourceMediaId: m.id, aiConfidence: 0.86 });
    const [after] = await withSystem((tx) => tx<{ needsReview: boolean; confirmedAt: Date | null }[]>`
      select needs_review, confirmed_at from ai_interpretations where id = ${r.interpretationId}`);
    expect(after!.needsReview).toBe(false);
    expect(after!.confirmedAt).not.toBeNull();
  });

  it('HEALTH-04: an unreadable photo gives a clear message and manual entry, no value', async () => {
    ai.see = true;
    ai.weight = { readable: false, value: null, unit: null, confidence: 0.2, otherNumbersVisible: false, note: 'размыто' };
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'weight_photo', source: 'web' });
    const before = await measurementCount(alice);
    const r = await analyzeMedia(alice, m.id, TUE_LUNCH);
    expect(r.proposal).toMatchObject({ kind: 'weight', canSave: false, value: null });
    expect(r.proposal.kind === 'weight' && r.proposal.message).toMatch(/Не могу уверенно прочитать.*вручную/);
    expect(await measurementCount(alice)).toBe(before);
  });

  it('HEALTH-02: a weekly steps total is never offered as a daily value', async () => {
    ai.see = true;
    ai.steps = { readable: true, value: 52310, period: 'week', dateShown: '27 окт. – 2 нояб.', dateIso: null, metric: 'steps', confidence: 0.95, note: null };
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'steps_screenshot', source: 'web' });
    const before = await measurementCount(alice);
    const r = await analyzeMedia(alice, m.id, TUE_LUNCH);
    expect(r.proposal).toMatchObject({ kind: 'steps', canSaveAsDaily: false, period: 'week' });
    expect(r.proposal.kind === 'steps' && r.proposal.message).toMatch(/неделю.*не сохраняю/);
    expect(await measurementCount(alice)).toBe(before);
    // the user types the daily value for a chosen day: stored as a screenshot value without AI confidence
    await confirmMedia(alice, m.id, TUE_LUNCH, { kind: 'measurement', metricType: 'steps', value: 7400, localDate: '2026-11-02', interpretationId: r.interpretationId });
    const [row] = await withSystem((tx) => tx<{ value: number; sourceType: string; aiConfidence: number | null }[]>`
      select value, source_type, ai_confidence from health_measurements where user_id = ${alice} and metric_type = 'steps' and local_date = '2026-11-02'`);
    expect(row).toMatchObject({ value: 7400, sourceType: 'screenshot', aiConfidence: null });
  });

  it('steps for a different day than today are proposed with that date, calories are refused', async () => {
    ai.see = true;
    ai.steps = { readable: true, value: 9100, period: 'day', dateShown: 'Вчера', dateIso: '2026-11-02', metric: 'steps', confidence: 0.9, note: null };
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'steps_screenshot', source: 'web' });
    const r = await analyzeMedia(alice, m.id, TUE_LUNCH);
    expect(r.proposal).toMatchObject({ kind: 'steps', canSaveAsDaily: true, suggestedDate: '2026-11-02', dateDiffers: true });
    ai.steps = { readable: true, value: 410, period: 'day', dateShown: 'Сегодня', dateIso: '2026-11-03', metric: 'calories', confidence: 0.9, note: null };
    const r2 = await analyzeMedia(alice, m.id, TUE_LUNCH);
    expect(r2.proposal).toMatchObject({ kind: 'steps', canSaveAsDaily: false });
  });

  it('an AI failure is reported (502) with a manual fallback and logged as an interpretation error', async () => {
    ai.see = true;
    ai.weight = new AIError('HTTP', 'ИИ: HTTP 500');
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'weight_photo', source: 'web' });
    const e = await appErr(analyzeMedia(alice, m.id, TUE_LUNCH));
    expect(e.status).toBe(502);
    expect(e.message).toMatch(/вручную/);
    const [row] = await withSystem((tx) => tx<{ error: string }[]>`select error from ai_interpretations where media_id = ${m.id}`);
    expect(row!.error).toBe('HTTP');
  });

  it('HEALTH-03: a meal photo is not "eaten" until the user answers', async () => {
    ai.see = true;
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'meal_photo', source: 'web' });
    const r = await analyzeMedia(alice, m.id, TUE_LUNCH);
    expect(r.proposal).toMatchObject({ kind: 'meal', readable: true, questions: ['Было ли масло?'] });
    const logs = () => withSystem(async (tx) => tx<{ consumptionStatus: string; mealSlot: string }[]>`select consumption_status, meal_slot from meal_logs where media_id = ${m.id}`);
    expect(await logs()).toHaveLength(0);
    const [lunch] = await withSystem((tx) => tx<{ id: string; status: string }[]>`
      select id, status from schedule_events where user_id = ${alice} and local_date = '2026-11-03' and kind = 'meal_lunch'`);
    expect(lunch!.status).not.toBe('completed');
    await confirmMedia(alice, m.id, TUE_LUNCH, { kind: 'meal', consumptionStatus: 'part', eventId: lunch!.id, description: 'рис, курица', interpretationId: r.interpretationId });
    expect(await logs()).toEqual([{ consumptionStatus: 'part', mealSlot: 'lunch' }]);
  });

  it('confirmation must match the photo purpose', async () => {
    const m = await saveImage(alice, TUE_LUNCH, { data: await testJpeg(), purpose: 'meal_photo', source: 'web' });
    const e = await appErr(confirmMedia(alice, m.id, TUE_LUNCH, { kind: 'measurement', metricType: 'weight', value: 60, localDate: '2026-11-03' }));
    expect(e.code).toBe('MEDIA_PURPOSE_MISMATCH');
  });

  it('screenshot retention 0 = the file is deleted right after the value is confirmed', async () => {
    await withUser(bob, (tx) => updatePrivacy(tx, bob, { screenshotRetentionDays: 0 }));
    const m = await saveImage(bob, TUE_LUNCH, { data: await testJpeg(), purpose: 'steps_screenshot', source: 'web' });
    const abs = join(storageRoot(), m.storagePath);
    const r = await confirmMedia(bob, m.id, TUE_LUNCH, { kind: 'measurement', metricType: 'steps', value: 6000, localDate: '2026-11-03' });
    expect(r.fileDeleted).toBe(true);
    expect(existsSync(abs)).toBe(false);
    const [row] = await withSystem((tx) => tx<{ value: number; sourceType: string }[]>`
      select value, source_type from health_measurements where user_id = ${bob} and metric_type = 'steps' and local_date = '2026-11-03'`);
    expect(row).toMatchObject({ value: 6000, sourceType: 'screenshot' });
  });
});

describe('voice transcription (web)', () => {
  it('not configured → 503 AI_NOT_CONFIGURED, no consent → 403, otherwise text; nothing is stored', async () => {
    const files = filesOf(bob).length;
    const privacy = privacySchema.parse({});
    expect((await appErr(transcribeAudio(bob, privacy, fakeOgg(), 'web'))).code).toBe('AI_NOT_CONFIGURED');
    ai.hear = true;
    const noConsent = await appErr(transcribeAudio(bob, privacy, fakeOgg(), 'web'));
    expect(noConsent.code).toBe('AI_CONSENT_REQUIRED');
    expect(noConsent.message).toMatch(/клавиатуры/);
    const ok = await transcribeAudio(bob, { ...privacy, aiVoiceConsent: true }, fakeOgg(), 'web');
    expect(ok.text).toBe('купить молоко');
    expect((await appErr(transcribeAudio(bob, { ...privacy, aiVoiceConsent: true }, Buffer.alloc(100, 7), 'web'))).code).toBe('UNSUPPORTED_AUDIO');
    expect(filesOf(bob).length).toBe(files);
  });
});
