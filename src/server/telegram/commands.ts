import { addDays, localDateOf, weekStartOf } from '@/domain/time';
import { inUser } from '../context';
import { env } from '../env';
import { dayEvents, ensureMaterialized } from '../services/planning';
import { getTodayData } from '../views/today';
import type { InlineButton } from './api';
import { btn, esc, formatDayPlan, HELP_TEXT } from './format';
import { disconnectTelegram, setTelegramNotifications } from './pairing';
import { reply, edit, type ChatSession } from './session';
import { showDurationChoice } from './extraWork';

/** Read-only plan views and settings commands. All data comes from the same services as the web. */

function appLink(path: string): InlineButton[][] {
  const base = env().APP_URL;
  return base.startsWith('https://') ? [[{ text: 'Открыть в приложении', url: `${base}${path}` }]] : [];
}

export async function cmdDay(s: ChatSession, which: 'today' | 'tomorrow'): Promise<void> {
  const r = await inUser(s.userId, async (tx, ctx) => {
    const today = localDateOf(s.now, ctx.tz);
    const date = which === 'today' ? today : addDays(today, 1);
    await ensureMaterialized(tx, ctx, s.now, today, addDays(weekStartOf(date), 6));
    const rows = await dayEvents(tx, ctx, date);
    return { rows, today, date, tz: ctx.tz };
  });
  await reply(s, formatDayPlan(r.date, r.today, r.rows, r.tz), appLink(which === 'today' ? '/today' : '/plan'));
}

export async function cmdNow(s: ChatSession): Promise<void> {
  const d = await inUser(s.userId, (tx, ctx) => getTodayData(tx, ctx, s.now));
  const lines = [`<b>${esc(d.now.headline)}</b>`];
  if (d.now.subline) lines.push(esc(d.now.subline));
  const next = d.events.filter((e) => d.now.nextIds.includes(e.id));
  if (next.length) {
    const tz = d.tz;
    const fmt = (iso: string) => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).format(new Date(iso));
    lines.push('', '<b>Дальше:</b>', ...next.map((e) => `<code>${fmt(e.startAt)}</code> ${esc(e.title)}`));
  }
  const row: InlineButton[] = [];
  for (const a of d.now.actions) {
    if (row.length >= 3) break;
    if (a.kind === 'transition' && a.eventId && a.transition) row.push(btn(a.label, `ev:${a.transition}:${a.eventId}`));
    else if (a.kind === 'extra_work') row.push(btn(a.label, `xw:0:${a.eventId ?? '0'}`));
  }
  await reply(s, lines.join('\n'), [...(row.length ? [row] : []), ...appLink('/today')]);
}

export async function cmdWork(s: ChatSession): Promise<void> {
  await showDurationChoice(s, '0');
}

export async function cmdHelp(s: ChatSession): Promise<void> {
  await reply(s, HELP_TEXT);
}

export async function cmdStop(s: ChatSession): Promise<void> {
  await setTelegramNotifications(s.userId, false, s.now, 'telegram');
  await reply(s, 'Уведомления в Telegram выключены. Команды и сообщения продолжают работать; напоминания видны в приложении.', [
    [btn('Включить уведомления', 'ntf:on')],
    [btn('Отвязать этот чат', 'unlink:ask')],
  ]);
}

export async function notificationsAction(s: ChatSession, on: boolean, messageId: number | undefined): Promise<string> {
  await setTelegramNotifications(s.userId, on, s.now, 'telegram');
  await edit(
    s,
    messageId,
    on ? 'Уведомления в Telegram включены.' : 'Уведомления в Telegram выключены.',
    on ? [[btn('Выключить', 'ntf:off')]] : [[btn('Включить уведомления', 'ntf:on')]],
  );
  return on ? 'Включены' : 'Выключены';
}

export async function unlinkAction(s: ChatSession, step: string, messageId: number | undefined): Promise<string> {
  if (step === 'ask') {
    await edit(s, messageId, 'Отвязать этот чат от аккаунта? Бот перестанет видеть твой план, пока не подключишь его снова в настройках.', [
      [btn('Да, отвязать', 'unlink:yes'), btn('Нет', 'unlink:no')],
    ]);
    return 'Подтверди';
  }
  if (step === 'yes') {
    await disconnectTelegram(s.userId, s.now, 'telegram');
    await edit(s, messageId, 'Чат отвязан. Подключить снова можно в приложении: Настройки → Telegram.');
    return 'Отвязано';
  }
  await edit(s, messageId, 'Хорошо, чат остаётся подключённым.');
  return 'Без изменений';
}
