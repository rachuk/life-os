import type { ExtraWorkPreview } from '@/domain/planner/extraWork';
import type { ProposedAction } from '@/domain/capture/schema';
import { ACTION_LABELS } from '@/domain/capture/schema';
import { formatDateRu, formatDuration, formatRange, formatTime, relativeDayLabel, type LocalDate } from '@/domain/time';
import { MEAL_SLOT_LABELS, type EventStatus } from '@/domain/types';
import type { InlineButton } from './api';

/** Message formatting for the bot (HTML parse mode). Every piece of user/AI text goes through esc(). */

export function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const LIMIT = 3900; // Telegram: 4096 chars per message

/** Trim long messages on a line boundary so HTML tags stay balanced (each line is self-contained). */
export function fit(text: string): string {
  if (text.length <= LIMIT) return text;
  const lines = text.split('\n');
  let out = '';
  for (const l of lines) {
    if (out.length + l.length + 2 > LIMIT) break;
    out += (out ? '\n' : '') + l;
  }
  return `${out}\n…`;
}

export const btn = (text: string, callbackData: string): InlineButton => ({ text, callbackData });

const STATUS_MARK: Partial<Record<EventStatus, string>> = {
  completed: '✓',
  started: '▶',
  skipped: '—',
  snoozed: '⏰',
  unanswered: '?',
  rescheduled: '↻',
};

export interface PlanLine {
  startAt: Date;
  endAt: Date;
  title: string;
  status: EventStatus;
}

/** 'Сегодня, Пн, 2 ноября' / 'Ср, 4 ноября' */
export function dayLabel(date: LocalDate, today: LocalDate): string {
  const rel = relativeDayLabel(date, today);
  const full = formatDateRu(date);
  return rel === full ? full : `${rel}, ${full}`;
}

export function formatDayPlan(date: LocalDate, today: LocalDate, rows: PlanLine[], tz: string): string {
  const head = `<b>${esc(dayLabel(date, today))}</b>`;
  const live = rows.filter((r) => r.status !== 'cancelled');
  if (!live.length) return `${head}\nВ плане пока ничего нет. План строится из распорядка в приложении.`;
  const lines = live.map((r) => {
    const mark = STATUS_MARK[r.status];
    return `${mark ? `${mark} ` : ''}<code>${formatRange(r.startAt, r.endAt, tz)}</code> ${esc(r.title)}`;
  });
  return fit(`${head}\n${lines.join('\n')}\n\n<i>✓ выполнено · ▶ начато · ⏰ отложено · ? без ответа</i>`);
}

export function formatPreview(p: ExtraWorkPreview, tz: string, today: LocalDate): string {
  const out: string[] = [];
  const day = p.request.date === today ? 'сегодня' : esc(formatDateRu(p.request.date));
  out.push(`<b>Предпросмотр: +${formatDuration(p.requestedMinutes)} работы ${day}</b>`);
  if (p.segments.length) {
    out.push(`Дополнительная работа: ${p.segments.map((s) => formatRange(s.startAt, s.endAt, tz)).join(', ')}`);
    if (p.plannedMinutes !== p.requestedMinutes) out.push(`Поместится ${formatDuration(p.plannedMinutes)} из ${formatDuration(p.requestedMinutes)}.`);
  }
  for (const n of p.notes) out.push(`<i>${esc(n)}</i>`);
  if (p.changes.length) {
    out.push('', '<b>Что изменится:</b>');
    for (const c of p.changes) {
      const to = c.to
        ? `${c.to.localDate !== c.from.localDate ? `${esc(formatDateRu(c.to.localDate))}, ` : ''}${formatRange(c.to.startAt, c.to.endAt, tz)}`
        : 'не состоится';
      out.push(`• ${esc(c.title)}: ${formatTime(c.from.startAt, tz)} → ${to}${c.reason ? ` — <i>${esc(c.reason)}</i>` : ''}`);
    }
  } else if (p.segments.length) {
    out.push('Другие дела не затронуты.');
  }
  for (const c of p.conflicts) out.push(`⛔ ${esc(c.message)}`);
  for (const r of p.weeklyTargetRisks) out.push(`⚠️ ${esc(r.message)}`);
  for (const w of p.warnings) out.push(`⚠️ ${esc(w)}`);
  if (p.canCommit) out.push('', 'Сон и еда не сокращаются. Ничего не изменится, пока не нажмёшь «Подтвердить».');
  return fit(out.join('\n'));
}

export function actionTitle(a: ProposedAction): string {
  switch (a.type) {
    case 'note':
      return a.text;
    case 'log_weight':
      return `${a.value} кг`;
    case 'log_steps':
      return `${a.value.toLocaleString('ru-RU')} шагов`;
    case 'log_meal':
      return `${MEAL_SLOT_LABELS[a.slot]}${a.description ? `: ${a.description}` : ''}`;
    case 'extra_work':
      return `+${formatDuration(a.durationMinutes)}`;
    default:
      return a.title;
  }
}

function whenOf(a: ProposedAction, today: LocalDate): string {
  const parts: string[] = [];
  if ('dateLocal' in a && a.dateLocal) parts.push(dayLabel(a.dateLocal, today));
  if ('timeLocal' in a && a.timeLocal) parts.push(a.timeLocal);
  if (a.type === 'create_waiting' && a.followUpDate) parts.push(`проверить ${formatDateRu(a.followUpDate)}`);
  return parts.length ? ` — ${esc(parts.join(' '))}` : '';
}

export function formatProposals(actions: ProposedAction[], today: LocalDate, opts: { note?: string | null; parser?: string | null } = {}): string {
  const out: string[] = [];
  out.push(actions.length > 1 ? '<b>Проверь, что создать:</b>' : '<b>Проверь:</b>');
  actions.forEach((a, i) => {
    out.push(`${i + 1}. ${esc(ACTION_LABELS[a.type])}: ${esc(actionTitle(a))}${whenOf(a, today)}${a.needsConfirmation && a.reason ? `\n   <i>${esc(a.reason)}</i>` : ''}`);
  });
  if (opts.note) out.push('', `<i>${esc(opts.note)}</i>`);
  out.push('', `Ничего не создано, пока не подтвердишь.${opts.parser && opts.parser !== 'rules' ? ' Разбор: ИИ — проверь.' : ''}`);
  return fit(out.join('\n'));
}

export const HELP_TEXT = [
  '<b>Life OS — команды</b>',
  '/today — план на сегодня',
  '/now — что сейчас',
  '/work — нужно поработать (сначала предпросмотр)',
  '/tomorrow — план на завтра',
  '/stop — выключить уведомления',
  '/help — эта справка',
  '',
  'Можно просто написать: «завтра написать брокеру, купить молоко» — предложу действия и ничего не создам без подтверждения.',
  'Голосовые и фото тоже принимаю: вес, шаги, еда.',
  '',
  '<i>Важно: у ботов Telegram нет сквозного шифрования — не присылай пароли и рабочие секреты.</i>',
].join('\n');

export const PAIRING_TEXT = [
  'Этот чат не привязан к аккаунту Life OS.',
  '',
  'Открой приложение → <b>Настройки → Telegram → «Подключить»</b> и перейди по ссылке (или отправь сюда показанную там команду <code>/start …</code>). Ссылка действует 10 минут.',
].join('\n');
