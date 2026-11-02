import type { DateTime } from 'luxon';
import type { ExtraWorkPreview, ExtraWorkRequest } from '@/domain/planner/extraWork';
import { formatDuration, formatRange, isoWeekday, localDateOf, localTimeOf, timeToMinutes } from '@/domain/time';
import { isUuid } from '../db';
import { inUser } from '../context';
import { AppError } from '../http';
import { extraWorkCommit, extraWorkPreview, getEventRow, undoVersion } from '../services/planning';
import type { UserContext } from '../services/profile';
import type { InlineButton } from './api';
import { btn, formatPreview } from './format';
import { edit, reply, type ChatSession } from './session';
import { getPending, newNonce, setPending, type PendingState } from './state';

/**
 * «Нужно поработать» in Telegram (PRD §5.4): duration → preview with the exact changes →
 * Подтвердить/Отмена. The commit goes through services/planning.extraWorkCommit with the plan
 * version and fingerprint of the preview the user saw; a stale preview (409) is refreshed, not applied.
 */

type Preview = ExtraWorkPreview & { basePlanVersion: number; fingerprint: string };

export const DURATION_CHOICES = [
  { minutes: 30, label: '+30м' },
  { minutes: 60, label: '+1ч' },
  { minutes: 120, label: '+2ч' },
  { minutes: 180, label: '+3ч' },
];

/** eventRef: the reminder's event id, or '0' when started from /work. */
export async function showDurationChoice(s: ChatSession, eventRef: string, editMessageId?: number): Promise<void> {
  const row: InlineButton[] = DURATION_CHOICES.map((d) => btn(d.label, `xd:${d.minutes}:${eventRef}`));
  const text = '<b>Нужно поработать</b>\nСколько ещё? Сначала покажу, что изменится в плане — сон и еда не сокращаются.';
  if (editMessageId) await edit(s, editMessageId, text, [row]);
  else await reply(s, text, [row]);
}

function requestFor(ctx: UserContext, now: DateTime, minutes: number, ev: { kind: string; localDate: string; endAt: Date } | null): ExtraWorkRequest {
  const today = localDateOf(now, ctx.tz);
  // "Ещё 30 мин" on a running extra-work block continues right after it
  if (ev && ev.kind === 'extra_work' && ev.endAt.getTime() > now.toMillis() && ev.localDate === today) {
    return { date: today, startMode: 'at', startTime: localTimeOf(ev.endAt, ctx.tz), durationMinutes: minutes, reason: null };
  }
  const isWorkDay = ctx.prefs.workDays.includes(isoWeekday(today));
  const afterWork = timeToMinutes(localTimeOf(now, ctx.tz)) >= timeToMinutes(ctx.prefs.workEnd);
  return { date: today, startMode: isWorkDay && !afterWork ? 'after_work' : 'now', startTime: null, durationMinutes: minutes, reason: null };
}

function previewButtons(p: Preview, nonce: string, eventRef: string): InlineButton[][] {
  if (p.canCommit) {
    return [
      [btn(p.requiresRiskAcknowledgement ? 'Понимаю риск, применить' : `Подтвердить +${formatDuration(p.plannedMinutes)}`, `xwc:${nonce}`)],
      [btn('Отмена', `xwx:${nonce}`)],
    ];
  }
  const shorter = p.conflicts.find((c) => c.suggestedDurationMinutes)?.suggestedDurationMinutes;
  const rows: InlineButton[][] = [];
  if (shorter && shorter >= 15) rows.push([btn(`Сократить до ${formatDuration(shorter)}`, `xd:${shorter}:${eventRef}`)]);
  rows.push([btn('Закрыть', `xwx:${nonce}`)]);
  return rows;
}

async function presentPreview(s: ChatSession, p: Preview, tz: string, eventRef: string, opts: { editMessageId?: number; prefix?: string }): Promise<void> {
  const nonce = newNonce();
  const today = localDateOf(s.now, tz);
  const text = `${opts.prefix ? `${opts.prefix}\n\n` : ''}${formatPreview(p, tz, today)}`;
  const buttons = previewButtons(p, nonce, eventRef);
  const messageId = opts.editMessageId ? await edit(s, opts.editMessageId, text, buttons) : await reply(s, text, buttons);
  const state: PendingState = {
    kind: 'extra_work',
    nonce,
    messageId,
    request: {
      date: p.request.date,
      startMode: p.request.startMode,
      startTime: p.request.startTime ?? null,
      durationMinutes: p.request.durationMinutes,
      reason: p.request.reason ?? null,
    },
    eventRef,
    expectedPlanVersion: p.basePlanVersion,
    fingerprint: p.fingerprint,
    requiresAck: p.requiresRiskAcknowledgement,
    at: new Date().toISOString(),
  };
  await setPending(s.userId, state);
}

export async function showExtraWorkPreview(s: ChatSession, minutes: number, eventRef: string, opts: { editMessageId?: number; prefix?: string } = {}): Promise<void> {
  const safeMinutes = Math.min(480, Math.max(15, Math.round(minutes)));
  const { preview, tz } = await inUser(s.userId, async (tx, ctx) => {
    let ev: { kind: string; localDate: string; endAt: Date } | null = null;
    if (isUuid(eventRef)) ev = await getEventRow(tx, ctx.userId, eventRef).catch(() => null); // RLS: only own events
    const req = requestFor(ctx, s.now, safeMinutes, ev);
    return { preview: await extraWorkPreview(tx, ctx, s.now, req), tz: ctx.tz };
  });
  await presentPreview(s, preview, tz, eventRef, opts);
}

const STALE = 'Этот предпросмотр устарел — нажми /work ещё раз.';

export async function commitExtraWork(s: ChatSession, nonce: string, messageId: number | undefined): Promise<string> {
  const st = await getPending(s.userId);
  if (!st || st.kind !== 'extra_work' || st.nonce !== nonce) {
    await edit(s, messageId, STALE);
    return 'Предпросмотр устарел';
  }
  try {
    const r = await inUser(s.userId, (tx, ctx) =>
      extraWorkCommit(
        tx,
        ctx,
        s.now,
        { ...st.request, expectedPlanVersion: st.expectedPlanVersion, fingerprint: st.fingerprint, acknowledgeRisks: st.requiresAck },
        'telegram',
      ),
    );
    await setPending(s.userId, null);
    const tz = await inUser(s.userId, async (_tx, ctx) => ctx.tz);
    const segs = r.preview.segments.map((x) => formatRange(x.startAt, x.endAt, tz)).join(', ');
    await edit(
      s,
      st.messageId ?? messageId,
      `✓ <b>План перестроен:</b> +${formatDuration(r.preview.plannedMinutes)} работы (${segs}).\nИзменено событий: ${r.preview.changes.length}. Напоминания пересчитаны.`,
      [[btn('Отменить изменения', `xwu:${r.versionId}`)]],
    );
    return 'Готово';
  } catch (e) {
    if (e instanceof AppError && ['PLAN_VERSION_CONFLICT', 'CANNOT_COMMIT', 'RISK_NOT_ACKNOWLEDGED'].includes(e.code)) {
      const fresh = (e.details as { preview?: Preview } | undefined)?.preview;
      if (fresh) {
        const tz = await inUser(s.userId, async (_tx, ctx) => ctx.tz);
        await presentPreview(s, fresh, tz, st.eventRef, { editMessageId: st.messageId ?? messageId, prefix: `⚠️ ${e.message}` });
      } else {
        await showExtraWorkPreview(s, st.request.durationMinutes, st.eventRef, { editMessageId: st.messageId ?? messageId, prefix: `⚠️ ${e.message}` });
      }
      return e.code === 'PLAN_VERSION_CONFLICT' ? 'План изменился — проверь ещё раз' : 'Нельзя применить';
    }
    throw e;
  }
}

export async function cancelExtraWork(s: ChatSession, nonce: string, messageId: number | undefined): Promise<string> {
  const st = await getPending(s.userId);
  if (st?.kind === 'extra_work' && st.nonce === nonce) await setPending(s.userId, null);
  await edit(s, messageId, 'Отменено — план не менялся.');
  return 'Отменено';
}

export async function undoExtraWork(s: ChatSession, versionId: string, messageId: number | undefined): Promise<string> {
  if (!isUuid(versionId)) return 'Не найдено';
  try {
    await inUser(s.userId, (tx, ctx) => undoVersion(tx, ctx, s.now, versionId, 'telegram'));
  } catch (e) {
    if (e instanceof AppError && e.code === 'ALREADY_REVERTED') {
      await edit(s, messageId, 'Эти изменения уже отменены.');
      return 'Уже отменено';
    }
    throw e;
  }
  await edit(s, messageId, '↩︎ Дополнительная работа отменена, план и напоминания восстановлены.');
  return 'Отменено';
}
