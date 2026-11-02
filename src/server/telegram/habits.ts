import { localDateOf } from '@/domain/time';
import { inUser } from '../context';
import { currentLimit, deleteHabitEvent, listPrograms, logHabitEvent, setEventReason } from '../services/habitChange';
import { btn, esc } from './format';
import { edit, reply, type ChatSession } from './session';

/** «/plus» — one message = +1 for the habit being changed; reason is an optional tap. */
export async function cmdPlus(s: ChatSession, kind: 'use' | 'urge_resisted' = 'use'): Promise<void> {
  const programs = await inUser(s.userId, (tx) => listPrograms(tx, s.userId));
  if (!programs.length) {
    await reply(s, 'Пока нет привычки для отслеживания. Включи её в приложении: «Ещё» → «Изменение привычек».');
    return;
  }
  if (programs.length > 1) {
    await reply(
      s,
      kind === 'use' ? 'Для какой привычки +1?' : 'Где удержался?',
      programs.map((p) => [btn(p.title, `hc:${kind === 'use' ? 'p' : 'h'}:${p.id}`)]),
    );
    return;
  }
  await logFor(s, programs[0]!.id, kind, null);
}

export async function logFor(s: ChatSession, programId: string, kind: 'use' | 'urge_resisted', editMessageId: number | null): Promise<string> {
  const r = await inUser(s.userId, (tx, ctx) => logHabitEvent(tx, ctx, s.now, programId, { kind }, 'telegram'));
  const p = r.program;
  if (kind === 'urge_resisted') {
    const text = `Удержался — отмечено (${esc(p.title)}). ${p.alternatives[0] ? `Хорошая замена: ${esc(p.alternatives[0].toLowerCase())}.` : ''}`;
    await edit(s, editMessageId, text, [[btn('Отменить', `hc:x:${r.id}`)]]);
    return 'Отмечено';
  }
  const limitText = r.limit !== null ? ` из ${r.limit}` : '';
  const reasons = p.reasons.slice(0, 6);
  const rows = [];
  for (let i = 0; i < reasons.length; i += 2) rows.push(reasons.slice(i, i + 2).map((t, j) => btn(t, `hc:r:${r.id}:${i + j}`)));
  rows.push([btn('Отменить', `hc:x:${r.id}`)]);
  await edit(s, editMessageId, `+1 · ${esc(p.title)}: сегодня <b>${r.todayTotal}${limitText}</b> ${esc(p.unitLabel)}.\nПричина? (необязательно)`, rows);
  return 'Записал';
}

export async function setReasonFromButton(s: ChatSession, eventId: string, index: number, messageId: number | undefined): Promise<string> {
  return inUser(s.userId, async (tx, ctx) => {
    const [ev] = await tx<{ programId: string }[]>`select program_id from habit_change_events where id = ${eventId} and user_id = ${s.userId}`;
    if (!ev) return 'Отметка не найдена';
    const programs = await listPrograms(tx, s.userId);
    const p = programs.find((x) => x.id === ev.programId);
    const reason = p?.reasons[index];
    if (!p || !reason) return 'Устарело';
    await setEventReason(tx, s.userId, eventId, reason);
    const today = localDateOf(s.now, ctx.tz);
    const limit = currentLimit(p, today);
    await edit(s, messageId, `+1 · ${esc(p.title)} · причина: ${esc(reason)}${limit !== null ? `\nЛимит на сегодня: ${limit}` : ''}`, [[btn('Отменить', `hc:x:${eventId}`)]]);
    return 'Причина сохранена';
  });
}

export async function undoFromButton(s: ChatSession, eventId: string, messageId: number | undefined): Promise<string> {
  try {
    await inUser(s.userId, (tx) => deleteHabitEvent(tx, s.userId, eventId));
  } catch {
    return 'Уже удалено';
  }
  await edit(s, messageId, 'Отметка удалена.');
  return 'Удалено';
}
