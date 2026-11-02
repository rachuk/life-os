import type { DateTime } from 'luxon';
import { formatRange, formatTime, localTimeOf, timeToMinutes } from '../time';
import type { EventKind } from '../types';
import type { ReminderSpec } from '../planner/prefs';

/**
 * Reminder rules (PRD §12). Pure: given an event, return the reminders it should have.
 * The worker reconciles these with the outbox (idempotent message keys) and sends them.
 */

export type ReminderKind = 'soft' | 'important' | 'review';
export type ReminderType = 'start' | 'lead' | 'end' | 'repeat';
export type Channel = 'in_app' | 'telegram' | 'web_push';

export interface ReminderEvent {
  id: string;
  kind: EventKind;
  title: string;
  startAt: DateTime;
  endAt: DateTime;
}

export interface PlannedReminder {
  reminderType: Exclude<ReminderType, 'repeat'>;
  kind: ReminderKind;
  scheduledAt: DateTime;
}

const DEFAULT_SPECS: Partial<Record<EventKind, ReminderSpec>> = {
  work: { type: 'important', atEnd: true },
  extra_work: { type: 'important', atEnd: true },
  meal_breakfast: { type: 'important' },
  meal_lunch: { type: 'important' },
  meal_dinner: { type: 'important' },
  snack: { type: 'soft' },
  workout: { type: 'important', leadMinutes: 30 },
  own_project: { type: 'soft' },
  task: { type: 'important' },
  review: { type: 'review' },
  weekly_review: { type: 'review' },
  sleep: { type: 'soft', leadMinutes: 30 },
  custom: { type: 'soft' },
};

export function effectiveSpec(kind: EventKind, templateSpec: ReminderSpec | null | undefined): ReminderSpec {
  if (templateSpec && templateSpec.type) return templateSpec;
  return DEFAULT_SPECS[kind] ?? { type: 'none' };
}

export function remindersForEvent(ev: ReminderEvent, spec: ReminderSpec): PlannedReminder[] {
  if (spec.type === 'none') return [];
  const kind: ReminderKind = spec.type;
  if (ev.kind === 'work' || ev.kind === 'extra_work' || spec.atEnd) {
    return [{ reminderType: 'end', kind, scheduledAt: ev.endAt }];
  }
  if (spec.leadMinutes && spec.leadMinutes > 0) {
    return [{ reminderType: 'lead', kind, scheduledAt: ev.startAt.minus({ minutes: spec.leadMinutes }) }];
  }
  return [{ reminderType: 'start', kind, scheduledAt: ev.startAt }];
}

export function inQuietHours(at: DateTime, tz: string, quiet: { start: string; end: string } | null): boolean {
  if (!quiet) return false;
  const m = timeToMinutes(localTimeOf(at, tz));
  const s = timeToMinutes(quiet.start);
  const e = timeToMinutes(quiet.end);
  if (s === e) return false;
  return s < e ? m >= s && m < e : m >= s || m < e;
}

export function messageKey(parts: {
  userId: string;
  eventId: string | null;
  reminderType: string;
  scheduledAt: DateTime | null;
  channel: Channel;
  scope?: string;
}): string {
  const at = parts.scheduledAt ? parts.scheduledAt.toUTC().toISO() : 'none';
  return [parts.userId, parts.eventId ?? parts.scope ?? 'global', parts.reminderType, at, parts.channel].join('|');
}

/** Repeat key deliberately excludes the time: at most ONE repeat per event reminder per channel (NT-02). */
export function repeatKey(userId: string, eventId: string, baseType: string, channel: Channel): string {
  return [userId, eventId, `${baseType}:repeat`, channel].join('|');
}

export type ButtonAction =
  | { type: 'transition'; transition: 'start' | 'complete' | 'snooze' | 'skip' }
  | { type: 'extra_work'; minutes?: number }
  | { type: 'open'; path: string };

export interface ReminderMessage {
  title: string;
  body: string;
  buttons: { label: string; action: ButtonAction }[];
  path: string;
}

export function reminderMessage(
  ev: ReminderEvent,
  reminderType: ReminderType,
  tz: string,
  extra: { pendingCount?: number } = {},
): ReminderMessage {
  const range = formatRange(ev.startAt, ev.endAt, tz);
  const repeatPrefix = reminderType === 'repeat' ? 'Напоминаю ещё раз: ' : '';
  const path = `/today?event=${ev.id}`;
  switch (ev.kind) {
    case 'meal_breakfast':
    case 'meal_lunch':
    case 'meal_dinner': {
      const name = ev.kind === 'meal_breakfast' ? 'завтрак' : ev.kind === 'meal_lunch' ? 'обед' : 'ужин';
      return {
        title: `${repeatPrefix}Пора на ${name}`,
        body: `${ev.title}, ${range}.`,
        buttons: [
          { label: 'Начал', action: { type: 'transition', transition: 'start' } },
          { label: '+15 мин', action: { type: 'transition', transition: 'snooze' } },
          { label: 'Не могу сейчас', action: { type: 'open', path } },
        ],
        path,
      };
    }
    case 'snack':
      return {
        title: 'Время перекуса',
        body: `Небольшой перекус, ${range}.`,
        buttons: [
          { label: 'Перекусил', action: { type: 'transition', transition: 'complete' } },
          { label: 'Пропущу', action: { type: 'transition', transition: 'skip' } },
        ],
        path,
      };
    case 'work':
      return {
        title: `${repeatPrefix}Завершил работу?`,
        body: `Рабочий блок по плану закончился в ${formatTime(ev.endAt, tz)}.`,
        buttons: [
          { label: 'Закончил', action: { type: 'transition', transition: 'complete' } },
          { label: 'Нужно поработать', action: { type: 'extra_work' } },
        ],
        path: '/today',
      };
    case 'extra_work':
      return {
        title: `${repeatPrefix}Закончил дополнительную работу?`,
        body: `Блок по плану ${range}.`,
        buttons: [
          { label: 'Да, закончил', action: { type: 'transition', transition: 'complete' } },
          { label: 'Ещё 30 мин', action: { type: 'extra_work', minutes: 30 } },
        ],
        path: '/today',
      };
    case 'workout':
      return {
        title: `${repeatPrefix}Скоро тренировка`,
        body: `${ev.title} в ${formatTime(ev.startAt, tz)}.`,
        buttons: [
          { label: 'Собираюсь', action: { type: 'transition', transition: 'start' } },
          { label: 'Перенести', action: { type: 'open', path } },
        ],
        path,
      };
    case 'sleep':
      return {
        title: 'Скоро отбой',
        body: `Сон по плану с ${formatTime(ev.startAt, tz)}. Хорошее время закрыть дела на сегодня.`,
        buttons: [{ label: 'План на завтра', action: { type: 'open', path: '/review/evening' } }],
        path: '/review/evening',
      };
    case 'review':
      return {
        title: 'Короткое завершение дня',
        body: extra.pendingCount
          ? `Без ответа событий: ${extra.pendingCount}. Пара минут — и план на завтра готов.`
          : 'Пара вопросов о дне и план на завтра.',
        buttons: [{ label: 'Открыть', action: { type: 'open', path: '/review/evening' } }],
        path: '/review/evening',
      };
    case 'weekly_review':
      return {
        title: 'Обзор недели',
        body: 'Посмотрим, что сработало, и решим, что поменять на следующей неделе.',
        buttons: [{ label: 'Открыть обзор', action: { type: 'open', path: '/review/week' } }],
        path: '/review/week',
      };
    default:
      return {
        title: `${repeatPrefix}${ev.title}`,
        body: range,
        buttons: [
          { label: 'Начал', action: { type: 'transition', transition: 'start' } },
          { label: 'Выполнил', action: { type: 'transition', transition: 'complete' } },
          { label: 'Перенести', action: { type: 'open', path } },
        ],
        path,
      };
  }
}
