import { localDateOf } from '@/domain/time';
import { inUser } from '../context';
import { AppError } from '../http';
import { captureText, confirmInboxItem, rejectInboxItem, type InboxItemRow } from '../services/inbox';
import { deleteMedia, saveVoice } from '../services/media';
import { audioFormat, maxAudioBytes, transcribeAudio, voiceAvailability } from '../services/voice';
import { withUser } from '../db';
import { btn, esc, formatProposals } from './format';
import { edit, reply, type ChatSession } from './session';
import { showExtraWorkPreview } from './extraWork';
import type { TgVoice } from './types';

/**
 * Free text and voice → the single inbox (PRD §6): proposals are shown with «Создать всё» /
 * «Отмена» and nothing is created before confirmation. Voice is transcribed only with consent and
 * the transcript is shown before any action (PRD §11.7).
 */

const MAX_VOICE_SECONDS = 5 * 60;

async function presentItem(s: ChatSession, item: InboxItemRow, opts: { note?: string | null; autoApplied?: boolean }): Promise<void> {
  const tz = await inUser(s.userId, async (_tx, ctx) => ctx.tz);
  const today = localDateOf(s.now, tz);
  const proposals = item.proposalsJson;
  if (opts.autoApplied) {
    const lines = proposals.filter((p) => p.status === 'applied').map((p) => `✓ ${esc(p.result?.message ?? 'Сохранено')}`);
    await reply(s, `Сохранено автоматически (простые действия):\n${lines.join('\n')}`);
    return;
  }
  if (item.processingStatus === 'confirmed' || item.processingStatus === 'rejected') {
    await reply(s, item.processingStatus === 'confirmed' ? 'Это сообщение уже обработано.' : 'Это сообщение уже отменено.');
    return;
  }
  if (!proposals.length) {
    await reply(s, 'Не нашёл, что сохранить. Попробуй сформулировать иначе или открой приложение.');
    return;
  }
  // "нужно поработать 2 часа" alone → straight into the extra-work preview flow
  const onlyExtra = proposals.every((p) => p.action.type === 'extra_work');
  if (onlyExtra) {
    const a = proposals[0]!.action;
    await inUser(s.userId, (tx, ctx) => confirmInboxItem(tx, ctx, s.now, item.id, { selected: proposals.map((p) => p.index) }, 'telegram'));
    await showExtraWorkPreview(s, a.type === 'extra_work' ? a.durationMinutes : 60, '0');
    return;
  }
  await reply(s, formatProposals(proposals.map((p) => p.action), today, { note: opts.note, parser: item.parser }), [
    [btn(proposals.length > 1 ? 'Создать всё' : 'Создать', `ib:ok:${item.id}`), btn('Отмена', `ib:no:${item.id}`)],
  ]);
}

export async function handleFreeText(s: ChatSession, text: string, messageId: number): Promise<void> {
  const r = await captureText(s.userId, s.now, {
    text: text.slice(0, 4000),
    idempotencyKey: `tg:${s.updateId}`,
    source: 'telegram',
    sourceRef: String(messageId),
    kind: 'text',
  });
  await presentItem(s, r.item, { note: r.note ?? r.item.error, autoApplied: r.autoApplied });
}

export async function confirmInbox(s: ChatSession, itemId: string, replace: boolean, messageId: number | undefined): Promise<string> {
  try {
    const r = await inUser(s.userId, async (tx, ctx) => {
      const [item] = await tx<{ proposalsJson: { index: number }[] }[]>`
        select proposals_json from inbox_items where id = ${itemId} and user_id = ${ctx.userId}`;
      if (!item) throw new AppError('NOT_FOUND', 'Запись не найдена', 404);
      return confirmInboxItem(tx, ctx, s.now, itemId, { selected: item.proposalsJson.map((p) => p.index), replaceMeasurements: replace }, 'telegram');
    });
    if (r.alreadyProcessed) {
      await edit(s, messageId, r.item.processingStatus === 'rejected' ? 'Это уже отменено — ничего не создано.' : 'Уже сохранено ранее — повторно ничего не создаю.');
      return 'Уже сохранено';
    }
    const lines = r.applied.map((p) => `✓ ${esc(p.result?.message ?? 'Готово')}`);
    await edit(s, messageId, `<b>Готово</b>\n${lines.join('\n') || 'Ничего не выбрано.'}`);
    const xw = r.deferred.find((d) => d.action.type === 'extra_work');
    if (xw && xw.action.type === 'extra_work') await showExtraWorkPreview(s, xw.action.durationMinutes, '0');
    return 'Сохранено';
  } catch (e) {
    if (e instanceof AppError && e.code === 'DUPLICATE_FOR_DATE') {
      await edit(s, messageId, `${esc(e.message)}\nОстальное из этого сообщения тоже пока не сохранено.`, [
        [btn('Заменить значение', `ib:rp:${itemId}`), btn('Отмена', `ib:no:${itemId}`)],
      ]);
      return 'Нужно решение';
    }
    if (e instanceof AppError && e.status < 500) {
      await edit(s, messageId, `Не сохранено: ${esc(e.message)}\nИсправь во входящих в приложении или отправь сообщение заново с уточнением.`);
      return 'Не сохранено';
    }
    throw e;
  }
}

export async function rejectInbox(s: ChatSession, itemId: string, messageId: number | undefined): Promise<string> {
  try {
    await withUser(s.userId, (tx) => rejectInboxItem(tx, s.userId, itemId));
  } catch (e) {
    if (!(e instanceof AppError && e.code === 'NOT_FOUND')) throw e;
  }
  await edit(s, messageId, 'Отменено — ничего не создано.');
  return 'Отменено';
}

export async function handleVoice(s: ChatSession, voice: TgVoice, messageId: number): Promise<void> {
  const privacy = await inUser(s.userId, async (_tx, ctx) => ctx.privacy);
  const av = voiceAvailability(privacy);
  if (!av.available) {
    // honest, and the audio is not even downloaded
    await reply(
      s,
      av.code === 'AI_NOT_CONFIGURED'
        ? 'Распознавание голоса не подключено — отправь текстом.'
        : 'Распознавание голоса выключено в настройках приватности (запись обрабатывается внешним сервисом). Отправь текстом или включи согласие: Настройки → Приватность.',
    );
    return;
  }
  const limit = maxAudioBytes();
  if ((voice.file_size ?? 0) > limit || (voice.duration ?? 0) > MAX_VOICE_SECONDS) {
    await reply(s, 'Запись слишком длинная — отправь короче (до 5 минут) или текстом.');
    return;
  }
  await s.client.sendChatAction?.(s.chatId, 'typing');
  const file = await s.client.getFile(voice.file_id);
  if ((file.fileSize ?? 0) > limit) {
    await reply(s, 'Запись слишком большая — отправь короче или текстом.');
    return;
  }
  const data = await s.client.downloadFile(file.filePath);
  let fmt: ReturnType<typeof audioFormat>;
  try {
    if (data.length > limit) throw new AppError('FILE_TOO_LARGE', 'Запись слишком большая — отправь короче или текстом.', 413);
    fmt = audioFormat(data);
  } catch (e) {
    await reply(s, e instanceof AppError ? esc(e.message) : 'Не удалось прочитать запись — отправь текстом.');
    return;
  }
  const media = await saveVoice(s.userId, s.now, { data, mime: fmt.mime, ext: fmt.ext, source: 'telegram' });
  let transcript: string;
  try {
    transcript = (await transcribeAudio(s.userId, privacy, data, 'telegram')).text.trim();
  } catch (e) {
    await reply(s, e instanceof AppError ? esc(e.message) : 'Не удалось распознать речь — отправь текстом.');
    return;
  } finally {
    if (!privacy.storeVoiceAudio) await deleteMedia(s.userId, media.id, 'telegram').catch(() => {});
    else await withUser(s.userId, (tx) => tx`update media_assets set processing_status = 'stored_private' where id = ${media.id}`).catch(() => {});
  }
  if (!transcript) {
    await reply(s, 'В записи не удалось разобрать слова — отправь текстом.');
    return;
  }
  // the transcript goes out before anything is parsed or applied (PRD §11.7)
  const shown = transcript.length > 1500 ? `${transcript.slice(0, 1500)}…` : transcript;
  await reply(s, `🎙 Распознал: «${esc(shown)}»\n<i>Проверь текст — особенно даты и числа.</i>`);
  const r = await captureText(s.userId, s.now, {
    text: transcript.slice(0, 4000),
    idempotencyKey: `tg:${s.updateId}`,
    source: 'telegram',
    sourceRef: String(messageId),
    kind: 'voice',
    mediaId: privacy.storeVoiceAudio ? media.id : null,
  });
  await presentItem(s, r.item, { note: r.note ?? r.item.error, autoApplied: r.autoApplied });
}
