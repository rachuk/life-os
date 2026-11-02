import type { DateTime } from 'luxon';
import { formatRange, formatTime, minutesBetween, type LocalTime } from '../time';
import { CONTAINER_KINDS, KIND_LABELS, MEAL_KINDS, type EventKind } from '../types';
import type { PlanEvent } from './model';

export type NowActionKind =
  | 'transition'
  | 'extra_work'
  | 'capture'
  | 'open_plan'
  | 'meal_log'
  | 'evening_review'
  | 'plan_tomorrow'
  | 'build_plan'
  | 'reschedule'
  | 'open_workout'
  | 'meal_eaten';

export interface NowAction {
  id: string;
  label: string;
  kind: NowActionKind;
  eventId?: string;
  transition?: 'start' | 'complete' | 'snooze' | 'skip';
  variant: 'primary' | 'secondary';
}

export type NowMode =
  | 'empty'
  | 'work'
  | 'work_end'
  | 'extra_work'
  | 'extra_work_end'
  | 'meal'
  | 'workout_soon'
  | 'workout'
  | 'activity'
  | 'evening'
  | 'sleep'
  | 'free';

export interface NowState {
  mode: NowMode;
  headline: string;
  subline: string | null;
  current: PlanEvent | null;
  container: PlanEvent | null;
  next: PlanEvent[];
  actions: NowAction[];
  pendingDecisions: PlanEvent[];
}

const ANSWER_KINDS: EventKind[] = [
  'meal_breakfast',
  'meal_lunch',
  'meal_dinner',
  'workout',
  'own_project',
  'skill',
  'task',
  'extra_work',
  'work',
  'custom',
];
const OPEN = new Set(['planned', 'notified', 'snoozed', 'unanswered']);

/**
 * Extra work that picks up where the main work block ends (starts ≤ 30 min after its end and
 * runs past it). The day then ends with the extra block, so "Завершил работу?" is not asked
 * separately — one question at the real end of the working day.
 */
export function continuedByExtraWork(
  work: { startAt: DateTime; endAt: DateTime },
  events: { kind: string; status: string; startAt: DateTime; endAt: DateTime }[],
): boolean {
  return events.some(
    (e) =>
      e.kind === 'extra_work' &&
      e.status !== 'cancelled' &&
      e.status !== 'skipped' &&
      e.startAt >= work.startAt &&
      e.startAt <= work.endAt.plus({ minutes: 30 }) &&
      e.endAt > work.endAt,
  );
}

export interface NowInput {
  now: DateTime;
  tz: string;
  events: PlanEvent[]; // today's + tonight's events (any status)
  workoutLeadMinutes: number;
  eveningReviewTime: LocalTime;
}

export function computeNow(input: NowInput): NowState {
  const { now, tz } = input;
  const live = input.events
    .filter((e) => e.status !== 'cancelled' && e.status !== 'skipped')
    .sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());

  const containing = live.filter((e) => e.startAt <= now && e.endAt > now);
  const container = containing.find((e) => CONTAINER_KINDS.includes(e.kind)) ?? null;
  const inner = containing
    .filter((e) => !CONTAINER_KINDS.includes(e.kind) && e.status !== 'completed')
    .sort((a, b) => minutesBetween(a.startAt, a.endAt) - minutesBetween(b.startAt, b.endAt))[0];
  const current = inner ?? (container && container.status !== 'completed' ? container : null);

  const next = live.filter((e) => e.startAt > now && e.status !== 'completed').slice(0, 5);
  const pendingDecisions = input.events.filter(
    (e) =>
      e.endAt <= now &&
      OPEN.has(e.status) &&
      ANSWER_KINDS.includes(e.kind) &&
      !(e.kind === 'work' && continuedByExtraWork(e, input.events)),
  );

  const capture: NowAction = { id: 'capture', label: 'Добавить мысль', kind: 'capture', variant: 'secondary' };
  const planToday: NowAction = { id: 'plan', label: 'План на сегодня', kind: 'open_plan', variant: 'secondary' };
  const base = { current, container, next, pendingDecisions };

  if (!live.length) {
    return {
      ...base,
      mode: 'empty',
      headline: 'На сегодня в плане ничего нет',
      subline: 'Проверь постоянный распорядок или добавь дела.',
      actions: [{ id: 'build', label: 'Построить план', kind: 'build_plan', variant: 'primary' }, capture],
    };
  }

  // 1) the main work block just ended (or about to) and has no answer yet
  const work = input.events.find((e) => e.kind === 'work');
  const extraNow = containing.find((e) => e.kind === 'extra_work' && e.status !== 'completed');
  if (
    work &&
    !extraNow &&
    (OPEN.has(work.status) || work.status === 'started') &&
    !continuedByExtraWork(work, input.events) &&
    now >= work.endAt.minus({ minutes: 10 }) &&
    now <= work.endAt.plus({ hours: 4 })
  ) {
    return {
      ...base,
      mode: 'work_end',
      headline: 'Завершил работу?',
      subline: `Основной рабочий блок по плану до ${formatTime(work.endAt, tz)}.`,
      actions: [
        { id: 'work_done', label: 'Закончил', kind: 'transition', transition: 'complete', eventId: work.id, variant: 'primary' },
        { id: 'extra', label: 'Нужно поработать', kind: 'extra_work', variant: 'secondary' },
      ],
    };
  }

  // 2) extra work in progress or just finished
  const extraDue = input.events.find(
    (e) => e.kind === 'extra_work' && (OPEN.has(e.status) || e.status === 'started') && e.endAt <= now && now <= e.endAt.plus({ hours: 2 }),
  );
  if (extraNow) {
    return {
      ...base,
      current: extraNow,
      mode: 'extra_work',
      headline: 'Дополнительная работа',
      subline: `По плану ${formatRange(extraNow.startAt, extraNow.endAt, tz)}.`,
      actions: [
        { id: 'xw_done', label: 'Закончил', kind: 'transition', transition: 'complete', eventId: extraNow.id, variant: 'primary' },
        { id: 'xw_more', label: 'Нужно ещё', kind: 'extra_work', variant: 'secondary' },
      ],
    };
  }
  if (extraDue) {
    return {
      ...base,
      mode: 'extra_work_end',
      headline: 'Закончил дополнительную работу?',
      subline: `Блок по плану закончился в ${formatTime(extraDue.endAt, tz)}.`,
      actions: [
        { id: 'xw_done', label: 'Да, закончил', kind: 'transition', transition: 'complete', eventId: extraDue.id, variant: 'primary' },
        { id: 'xw_more', label: 'Нужно ещё', kind: 'extra_work', variant: 'secondary' },
      ],
    };
  }

  // 3) a meal right now
  if (current && MEAL_KINDS.includes(current.kind)) {
    const label = KIND_LABELS[current.kind].toLowerCase();
    if (current.status === 'started') {
      return {
        ...base,
        mode: 'meal',
        headline: `${KIND_LABELS[current.kind]} идёт`,
        subline: formatRange(current.startAt, current.endAt, tz),
        actions: [
          { id: 'meal_eaten', label: 'Поел', kind: 'meal_eaten', eventId: current.id, variant: 'primary' },
          { id: 'meal_log', label: 'Часть / другое', kind: 'meal_log', eventId: current.id, variant: 'secondary' },
        ],
      };
    }
    return {
      ...base,
      mode: 'meal',
      headline: current.kind === 'snack' ? 'Время перекуса' : `Пора на ${label === 'завтрак' ? 'завтрак' : label}`,
      subline: formatRange(current.startAt, current.endAt, tz),
      actions: [
        { id: 'meal_eaten', label: 'Поел', kind: 'meal_eaten', eventId: current.id, variant: 'primary' },
        { id: 'meal_snooze', label: '+15 минут', kind: 'transition', transition: 'snooze', eventId: current.id, variant: 'secondary' },
        { id: 'meal_skip', label: 'Не могу сейчас', kind: 'reschedule', eventId: current.id, variant: 'secondary' },
      ],
    };
  }

  // 4) workout now or soon
  const workoutSoon = live.find(
    (e) =>
      e.kind === 'workout' &&
      OPEN.has(e.status) &&
      e.startAt > now &&
      e.startAt.diff(now, 'minutes').minutes <= input.workoutLeadMinutes,
  );
  if (current?.kind === 'workout') {
    return {
      ...base,
      mode: 'workout',
      headline: current.status === 'started' ? 'Тренировка идёт' : 'Время тренировки',
      subline: formatRange(current.startAt, current.endAt, tz),
      actions:
        current.status === 'started'
          ? [{ id: 'wo_open', label: 'Записать подходы', kind: 'open_workout', eventId: current.id, variant: 'primary' }]
          : [
              { id: 'wo_start', label: 'Начал', kind: 'transition', transition: 'start', eventId: current.id, variant: 'primary' },
              { id: 'wo_move', label: 'Перенести с причиной', kind: 'reschedule', eventId: current.id, variant: 'secondary' },
            ],
    };
  }
  if (workoutSoon) {
    return {
      ...base,
      mode: 'workout_soon',
      headline: 'Скоро выходить на тренировку',
      subline: `Начало в ${formatTime(workoutSoon.startAt, tz)}.`,
      actions: [
        { id: 'wo_ready', label: 'Собираюсь', kind: 'transition', transition: 'start', eventId: workoutSoon.id, variant: 'primary' },
        { id: 'wo_move', label: 'Перенести с причиной', kind: 'reschedule', eventId: workoutSoon.id, variant: 'secondary' },
      ],
    };
  }

  // 5) sleep
  if (current?.kind === 'sleep') {
    return {
      ...base,
      mode: 'sleep',
      headline: 'Время сна',
      subline: `Подъём в ${formatTime(current.endAt, tz)}. Если не спится — запиши мысль и отложи телефон.`,
      actions: [capture],
    };
  }

  // 6) evening wrap-up
  const review = live.find((e) => e.kind === 'review');
  if (review && now >= review.startAt.minus({ minutes: 5 }) && review.status !== 'completed') {
    return {
      ...base,
      mode: 'evening',
      headline: 'Короткое завершение дня',
      subline: pendingDecisions.length ? `Без ответа: ${pendingDecisions.length}.` : 'Пара вопросов и план на завтра.',
      actions: [
        { id: 'evening', label: 'Завершить день', kind: 'evening_review', variant: 'primary' },
        { id: 'tomorrow', label: 'План на завтра', kind: 'plan_tomorrow', variant: 'secondary' },
      ],
    };
  }

  // 7) other concrete activity
  if (current && current.kind !== 'work' && current.kind !== 'morning_routine') {
    return {
      ...base,
      mode: 'activity',
      headline: current.title,
      subline: formatRange(current.startAt, current.endAt, tz),
      actions:
        current.status === 'started'
          ? [{ id: 'act_done', label: 'Выполнил', kind: 'transition', transition: 'complete', eventId: current.id, variant: 'primary' }, capture]
          : [
              { id: 'act_start', label: 'Начал', kind: 'transition', transition: 'start', eventId: current.id, variant: 'primary' },
              { id: 'act_move', label: 'Перенести', kind: 'reschedule', eventId: current.id, variant: 'secondary' },
            ],
    };
  }

  // 8) inside the work block or morning
  if (current?.kind === 'work') {
    const nextBreak = live.find((e) => e.startAt > now && e.endAt <= current.endAt && MEAL_KINDS.includes(e.kind));
    return {
      ...base,
      mode: 'work',
      headline: 'Рабочий день идёт',
      subline: nextBreak
        ? `Следующий перерыв — ${KIND_LABELS[nextBreak.kind].toLowerCase()} в ${formatTime(nextBreak.startAt, tz)}.`
        : `До ${formatTime(current.endAt, tz)}.`,
      actions: [capture, planToday],
    };
  }
  if (current?.kind === 'morning_routine') {
    return {
      ...base,
      mode: 'activity',
      headline: current.title,
      subline: `До ${formatTime(current.endAt, tz)}. Не торопись — время на утро заложено.`,
      actions: [capture, planToday],
    };
  }

  const upcoming = next[0];
  return {
    ...base,
    mode: 'free',
    headline: 'Свободное время',
    subline: upcoming ? `Дальше: ${upcoming.title} в ${formatTime(upcoming.startAt, tz)}.` : 'На сегодня больше ничего не запланировано.',
    actions: [capture, { id: 'extra', label: 'Нужно поработать', kind: 'extra_work', variant: 'secondary' }],
  };
}
