import { addDays, formatDateRu, localDateOf, type LocalDate } from '@/domain/time';
import { CONSUMPTION_LABELS, MEAL_SLOT_LABELS, type ConsumptionStatus } from '@/domain/types';
import { parseNumberInput, type MealProposal, type StepsProposal, type WeightProposal } from '@/domain/media/evaluate';
import { inUser } from '../context';
import { AppError } from '../http';
import {
  aiImagesAvailable,
  analyzeMedia,
  confirmMedia,
  deleteMedia,
  IMAGE_MIME_TYPES,
  maxUploadBytes,
  mealTargets,
  saveImage,
  setMediaPurpose,
  type MediaPurpose,
} from '../services/media';
import type { InlineButton } from './api';
import { btn, esc } from './format';
import { edit, reply, type ChatSession } from './session';
import { getPending, setPending, type PendingState } from './state';

/**
 * Photos and image documents (PRD §11): stored privately first, then the user says what it is.
 * Body photos are kept only with opt-in (HEALTH-06); numbers are proposed, never saved silently;
 * a weekly steps total is never saved as a daily value (HEALTH-02); unreadable → manual (HEALTH-04);
 * a meal photo does not mean "eaten" until the user answers (HEALTH-03).
 */

export const PURPOSE_CODES: Record<string, MediaPurpose> = { w: 'weight_photo', s: 'steps_screenshot', m: 'meal_photo', p: 'progress_photo', o: 'other' };

const ASK_NUMBER: Record<'weight' | 'steps', string> = {
  weight: 'Напиши вес числом, например <code>53.2</code> (можно «53.2 вчера»).',
  steps: 'Напиши число шагов за конкретный день, например <code>8500</code> (за сегодня) или <code>8500 вчера</code>.',
};

const nowIso = () => new Date().toISOString();

export async function handleIncomingImage(s: ChatSession, file: { fileId: string; fileSize?: number; mime?: string | null }): Promise<void> {
  if (file.mime && !(IMAGE_MIME_TYPES as readonly string[]).includes(file.mime.toLowerCase())) {
    await reply(s, 'Этот файл не изображение. Принимаю фото и скриншоты (JPEG, PNG, WebP).');
    return;
  }
  const limit = maxUploadBytes();
  if ((file.fileSize ?? 0) > limit) {
    await reply(s, `Файл больше ${Math.round(limit / 1048576)} МБ — отправь фото поменьше.`);
    return;
  }
  await s.client.sendChatAction?.(s.chatId, 'upload_photo');
  const meta = await s.client.getFile(file.fileId);
  if ((meta.fileSize ?? 0) > limit) {
    await reply(s, `Файл больше ${Math.round(limit / 1048576)} МБ — отправь фото поменьше.`);
    return;
  }
  const data = await s.client.downloadFile(meta.filePath);
  let mediaId: string;
  try {
    mediaId = (await saveImage(s.userId, s.now, { data, purpose: 'pending', source: 'telegram' })).id;
  } catch (e) {
    if (e instanceof AppError && e.status < 500) {
      await reply(s, esc(e.message));
      return;
    }
    throw e;
  }
  await reply(s, '<b>Что на фото?</b>\nОт этого зависит, что с ним делать. Фото хранится приватно, геоданные удалены.', [
    [btn('Вес', `mp:w:${mediaId}`), btn('Шаги', `mp:s:${mediaId}`)],
    [btn('Еда', `mp:m:${mediaId}`), btn('Фото прогресса', `mp:p:${mediaId}`)],
    [btn('Другое', `mp:o:${mediaId}`), btn('Удалить', `mp:x:${mediaId}`)],
  ]);
}

export async function choosePurpose(s: ChatSession, code: string, mediaId: string, messageId: number | undefined): Promise<string> {
  if (code === 'x') {
    await deleteMedia(s.userId, mediaId, 'telegram').catch((e) => {
      if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e;
    });
    await edit(s, messageId, 'Фото удалено.');
    return 'Удалено';
  }
  const purpose = PURPOSE_CODES[code];
  if (!purpose) return 'Неизвестная кнопка';
  try {
    await setMediaPurpose(s.userId, mediaId, purpose, s.now, 'telegram');
  } catch (e) {
    if (e instanceof AppError && e.status < 500) {
      await edit(s, messageId, esc(e.message));
      return e.code === 'BODY_PHOTOS_OPT_IN_REQUIRED' ? 'Не сохранено' : 'Не получилось';
    }
    throw e;
  }
  if (purpose === 'progress_photo') {
    await edit(s, messageId, 'Сохранено приватно как фото прогресса. ИИ-анализ для фото тела не выполняется. Удалить можно здесь или в приложении.', [
      [btn('Удалить', `mp:x:${mediaId}`)],
    ]);
    return 'Сохранено';
  }
  if (purpose === 'other') {
    const privacy = await inUser(s.userId, async (_tx, ctx) => ctx.privacy);
    await edit(
      s,
      messageId,
      `Сохранено приватно на ${Math.max(1, privacy.screenshotRetentionDays)} дн. Распознавание для такого фото не выполняется — пока умею разбирать фото весов, шагов и еды.`,
      [[btn('Удалить', `mp:x:${mediaId}`)]],
    );
    return 'Сохранено';
  }
  await edit(s, messageId, `Фото: ${purpose === 'weight_photo' ? 'вес' : purpose === 'steps_screenshot' ? 'шаги' : 'еда'}.`);
  if (purpose === 'meal_photo') await mealFlow(s, mediaId);
  else await valueFlow(s, mediaId, purpose === 'weight_photo' ? 'weight' : 'steps');
  return 'Принято';
}

async function askManual(s: ChatSession, mediaId: string, metric: 'weight' | 'steps', lead: string, messageId?: number): Promise<void> {
  await setPending(s.userId, { kind: 'await_value', mediaId, metric, at: nowIso() });
  const text = `${lead}\n${ASK_NUMBER[metric]}`;
  if (messageId) await edit(s, messageId, text);
  else await reply(s, text);
}

function shortDate(d: LocalDate, today: LocalDate): string {
  return d === today ? 'сегодня' : d === addDays(today, -1) ? 'вчера' : formatDateRu(d);
}

async function valueFlow(s: ChatSession, mediaId: string, metric: 'weight' | 'steps'): Promise<void> {
  const { privacy, tz } = await inUser(s.userId, async (_tx, ctx) => ({ privacy: ctx.privacy, tz: ctx.tz }));
  const av = aiImagesAvailable(privacy);
  if (!av.available) {
    const why = av.reason === 'not_configured' ? 'Распознавание фото не подключено.' : 'Отправка фото в ИИ выключена в настройках приватности.';
    await askManual(s, mediaId, metric, why);
    return;
  }
  await s.client.sendChatAction?.(s.chatId, 'typing');
  let result: Awaited<ReturnType<typeof analyzeMedia>>;
  try {
    result = await analyzeMedia(s.userId, mediaId, s.now);
  } catch (e) {
    if (e instanceof AppError && e.status !== 404) {
      await askManual(s, mediaId, metric, esc(e.message));
      return;
    }
    throw e;
  }
  const today = localDateOf(s.now, tz);
  const p = result.proposal;
  if (p.kind === 'weight') {
    await presentWeight(s, mediaId, p, result.interpretationId, today);
  } else if (p.kind === 'steps') {
    await presentSteps(s, mediaId, p, result.interpretationId, today);
  }
}

async function presentWeight(s: ChatSession, mediaId: string, p: WeightProposal, interpretationId: string, today: LocalDate): Promise<void> {
  const hints = p.hints.map((h) => `<i>${esc(h)}</i>`).join('\n');
  if (!p.canSave || p.value === null) {
    await askManual(s, mediaId, 'weight', `${esc(p.message)}${hints ? `\n${hints}` : ''}`);
    return;
  }
  await setPending(s.userId, { kind: 'photo_value', mediaId, metric: 'weight', value: p.value, localDate: today, interpretationId, at: nowIso() });
  await reply(s, `${esc(p.message)}${hints ? `\n${hints}` : ''}\nФото не доказывает время взвешивания — сохраню за сегодня.`, [
    [btn(`Сохранить ${p.value} кг`, `pv:ok:${mediaId}`)],
    [btn('Ввести вручную', `pv:man:${mediaId}`)],
  ]);
}

async function presentSteps(s: ChatSession, mediaId: string, p: StepsProposal, interpretationId: string, today: LocalDate): Promise<void> {
  const hints = p.hints.map((h) => `<i>${esc(h)}</i>`).join('\n');
  if (!p.canSaveAsDaily || p.value === null) {
    // HEALTH-02: weekly/monthly/unknown periods, calories etc. are never offered as a daily value
    await askManual(s, mediaId, 'steps', `${esc(p.message)}${hints ? `\n${hints}` : ''}`);
    return;
  }
  await setPending(s.userId, { kind: 'photo_value', mediaId, metric: 'steps', value: p.value, localDate: p.suggestedDate, interpretationId, at: nowIso() });
  const rows: InlineButton[][] = [];
  if (p.suggestedDate) {
    rows.push([btn(`Сохранить за ${shortDate(p.suggestedDate, today)}`, `pv:ok:${mediaId}`)]);
    if (p.dateDiffers) rows.push([btn('Нет, это за сегодня', `pv:today:${mediaId}`)]);
  } else {
    rows.push([btn('За сегодня', `pv:today:${mediaId}`), btn('За вчера', `pv:yday:${mediaId}`)]);
  }
  rows.push([btn('Ввести вручную', `pv:man:${mediaId}`)]);
  await reply(s, `${esc(p.message)}${hints ? `\n${hints}` : ''}`, rows);
}

async function saveValue(
  s: ChatSession,
  st: { mediaId: string; metric: 'weight' | 'steps'; value: number; localDate: LocalDate; interpretationId: string | null },
  replace: boolean,
  messageId?: number,
): Promise<string> {
  const today = localDateOf(s.now, await inUser(s.userId, async (_tx, ctx) => ctx.tz));
  try {
    const r = await confirmMedia(
      s.userId,
      st.mediaId,
      s.now,
      { kind: 'measurement', metricType: st.metric, value: st.value, localDate: st.localDate, replace, interpretationId: st.interpretationId },
      'telegram',
    );
    await setPending(s.userId, null);
    const m = r.kind === 'measurement' ? r.measurement : null;
    const what = st.metric === 'weight' ? `${m?.value ?? st.value} кг` : `${(m?.value ?? st.value).toLocaleString('ru-RU')} шагов`;
    const text = `✓ Сохранено: ${what} за ${shortDate(st.localDate, today)} (источник: ${st.metric === 'weight' ? 'фото' : 'скриншот'}, подтверждено тобой).${r.fileDeleted ? '\nСкриншот удалён по настройкам хранения.' : ''}`;
    if (messageId) await edit(s, messageId, text);
    else await reply(s, text);
    return 'Сохранено';
  } catch (e) {
    if (e instanceof AppError && e.code === 'DUPLICATE_FOR_DATE') {
      await setPending(s.userId, { kind: 'photo_value', ...st, at: nowIso() });
      const buttons = [[btn('Заменить', `pv:rp:${st.mediaId}`), btn('Оставить старое', `pv:keep:${st.mediaId}`)]];
      if (messageId) await edit(s, messageId, esc(e.message), buttons);
      else await reply(s, esc(e.message), buttons);
      return 'Уже есть значение';
    }
    if (e instanceof AppError && e.status < 500) {
      await setPending(s.userId, { kind: 'await_value', mediaId: st.mediaId, metric: st.metric, at: nowIso() });
      await reply(s, `${esc(e.message)}\n${ASK_NUMBER[st.metric]}`);
      return 'Не сохранено';
    }
    throw e;
  }
}

export async function photoValueAction(s: ChatSession, action: string, mediaId: string, messageId: number | undefined): Promise<string> {
  const st = await getPending(s.userId);
  const tz = await inUser(s.userId, async (_tx, ctx) => ctx.tz);
  const today = localDateOf(s.now, tz);
  if (action === 'man') {
    const metric = st && 'metric' in st && st.mediaId === mediaId ? st.metric : null;
    if (!metric) {
      await edit(s, messageId, 'Это предложение устарело — отправь фото ещё раз или введи значение в приложении.');
      return 'Устарело';
    }
    await askManual(s, mediaId, metric, 'Хорошо, введи сам.', messageId);
    return 'Жду число';
  }
  if (!st || st.kind !== 'photo_value' || st.mediaId !== mediaId) {
    await edit(s, messageId, 'Это предложение устарело — отправь фото ещё раз или введи значение в приложении.');
    return 'Устарело';
  }
  if (action === 'keep') {
    await setPending(s.userId, null);
    await edit(s, messageId, 'Оставил прежнее значение.');
    return 'Без изменений';
  }
  const date = action === 'today' ? today : action === 'yday' ? addDays(today, -1) : (st.localDate ?? today);
  return saveValue(s, { mediaId, metric: st.metric, value: st.value, localDate: date, interpretationId: st.interpretationId }, action === 'rp', messageId);
}

/** A typed reply while a photo waits for its number. Returns false if the text is not a number. */
export async function handleAwaitedValue(s: ChatSession, st: Extract<PendingState, { kind: 'await_value' }>, text: string): Promise<boolean> {
  const value = parseNumberInput(text);
  if (value === null) return false;
  const tz = await inUser(s.userId, async (_tx, ctx) => ctx.tz);
  const today = localDateOf(s.now, tz);
  const lower = text.toLowerCase();
  const date = /позавчера/.test(lower) ? addDays(today, -2) : /вчера/.test(lower) ? addDays(today, -1) : today;
  await saveValue(s, { mediaId: st.mediaId, metric: st.metric, value, localDate: date, interpretationId: null }, false);
  return true;
}

// ---------------------------------------------------------------------------
// meals
// ---------------------------------------------------------------------------
const MEAL_CODES: Record<string, ConsumptionStatus> = { all: 'all', part: 'part', repl: 'replaced', none: 'not_eaten' };

function mealText(p: MealProposal | null): string {
  if (!p) return '';
  const out: string[] = [esc(p.message)];
  if (p.detected.length) out.push(`<b>Обнаружено:</b> ${p.detected.map((d) => `${esc(d.name)} (${Math.round(d.confidence * 100)}%)`).join(', ')}`);
  if (p.possible.length) out.push(`<b>Возможно:</b> ${p.possible.map(esc).join(', ')}`);
  if (p.notVisible.length) out.push(`<b>Не видно:</b> ${p.notVisible.map(esc).join(', ')}`);
  if (p.portionNote) out.push(`<i>${esc(p.portionNote)}</i>`);
  if (p.questions.length) out.push(`<b>Вопросы:</b>\n${p.questions.map((q) => `• ${esc(q)}`).join('\n')}`);
  return out.join('\n');
}

async function mealFlow(s: ChatSession, mediaId: string): Promise<void> {
  const { privacy, target } = await inUser(s.userId, async (tx, ctx) => ({ privacy: ctx.privacy, target: (await mealTargets(tx, ctx, s.now)).suggested }));
  let proposal: MealProposal | null = null;
  let interpretationId: string | null = null;
  let lead = '';
  const av = aiImagesAvailable(privacy);
  if (av.available) {
    await s.client.sendChatAction?.(s.chatId, 'typing');
    try {
      const r = await analyzeMedia(s.userId, mediaId, s.now);
      if (r.proposal.kind === 'meal') {
        proposal = r.proposal;
        interpretationId = r.interpretationId;
      }
    } catch (e) {
      if (!(e instanceof AppError) || e.status === 404) throw e;
      lead = esc(e.message);
    }
  } else {
    lead = av.reason === 'not_configured' ? 'Распознавание фото не подключено — фото сохранено как отметка к приёму пищи.' : 'Отправка фото в ИИ выключена — фото сохранено как отметка к приёму пищи.';
  }
  const description = proposal?.readable ? proposal.detected.map((d) => d.name).join(', ').slice(0, 500) : null;
  await setPending(s.userId, { kind: 'meal', mediaId, eventId: target.eventId, slot: target.slot, description, interpretationId, at: nowIso() });
  const body = [mealText(proposal) || lead, '', `Отметить: <b>${esc(target.label)}</b> — сколько съел?`, '<i>Пока не ответишь, приём пищи не считается съеденным.</i>'].join('\n');
  await reply(s, body, [
    [btn(CONSUMPTION_LABELS.all, `ml:all:${mediaId}`), btn(CONSUMPTION_LABELS.part, `ml:part:${mediaId}`)],
    [btn('Заменил', `ml:repl:${mediaId}`), btn(CONSUMPTION_LABELS.not_eaten, `ml:none:${mediaId}`)],
  ]);
}

export async function mealAction(s: ChatSession, code: string, mediaId: string, messageId: number | undefined): Promise<string> {
  const status = MEAL_CODES[code];
  if (!status) return 'Неизвестная кнопка';
  const st = await getPending(s.userId);
  const pending = st?.kind === 'meal' && st.mediaId === mediaId ? st : null;
  try {
    const r = await confirmMedia(
      s.userId,
      mediaId,
      s.now,
      {
        kind: 'meal',
        consumptionStatus: status,
        eventId: pending?.eventId ?? null,
        slot: pending?.slot,
        description: pending?.description ?? null,
        interpretationId: pending?.interpretationId ?? null,
      },
      'telegram',
    );
    if (pending) await setPending(s.userId, null);
    const slot = r.kind === 'meal' ? r.mealLog.slot : (pending?.slot ?? 'lunch');
    await edit(s, messageId, `✓ Отмечено: ${MEAL_SLOT_LABELS[slot as keyof typeof MEAL_SLOT_LABELS] ?? 'приём пищи'} — ${CONSUMPTION_LABELS[status].toLowerCase()}.`);
    return 'Отмечено';
  } catch (e) {
    if (e instanceof AppError && e.status < 500) {
      await edit(s, messageId, `Не сохранено: ${esc(e.message)}`);
      return 'Не сохранено';
    }
    throw e;
  }
}
