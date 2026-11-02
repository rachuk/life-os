// Shared domain vocabulary (PRD §16.1). Statuses must not be mixed between UI, server and reports.

export type EventPriority = 'fixed' | 'protected' | 'required_movable' | 'flexible' | 'buffer';

export type EventStatus =
  | 'planned'
  | 'notified'
  | 'started'
  | 'completed'
  | 'snoozed'
  | 'rescheduled'
  | 'skipped'
  | 'unanswered'
  | 'cancelled';

export type DataSource = 'manual' | 'telegram' | 'photo' | 'screenshot' | 'health_import' | 'ai_estimate';

export type RoutineDayMode = 'normal' | 'busy' | 'overloaded' | 'recovery';

export type EventKind =
  | 'work'
  | 'extra_work'
  | 'morning_routine'
  | 'meal_breakfast'
  | 'meal_lunch'
  | 'meal_dinner'
  | 'snack'
  | 'sleep'
  | 'workout'
  | 'own_project'
  | 'skill'
  | 'task'
  | 'review'
  | 'weekly_review'
  | 'free_time'
  | 'custom';

export const MEAL_KINDS: EventKind[] = ['meal_breakfast', 'meal_lunch', 'meal_dinner', 'snack'];

/** Kinds that act as a background "container" for shorter events (lunch inside work). */
export const CONTAINER_KINDS: EventKind[] = ['work', 'morning_routine'];

/** Statuses that mean the user has answered / the event is settled. */
export const SETTLED_STATUSES: EventStatus[] = ['completed', 'skipped', 'cancelled'];
export const ACTIVE_STATUSES: EventStatus[] = ['planned', 'notified', 'snoozed', 'started', 'unanswered', 'rescheduled'];
/** Statuses for which reminders may still be sent. */
export const REMINDABLE_STATUSES: EventStatus[] = ['planned', 'notified', 'snoozed'];

export const KIND_LABELS: Record<EventKind, string> = {
  work: 'Работа',
  extra_work: 'Дополнительная работа',
  morning_routine: 'Утро',
  meal_breakfast: 'Завтрак',
  meal_lunch: 'Обед',
  meal_dinner: 'Ужин',
  snack: 'Перекус',
  sleep: 'Сон',
  workout: 'Тренировка',
  own_project: 'Свой проект',
  skill: 'Навык',
  task: 'Дело',
  review: 'Завершение дня',
  weekly_review: 'Обзор недели',
  free_time: 'Свободное время',
  custom: 'Событие',
};

export const PRIORITY_LABELS: Record<EventPriority, string> = {
  fixed: 'Неподвижное',
  protected: 'Защищённое',
  required_movable: 'Обязательное, можно двигать',
  flexible: 'Гибкое',
  buffer: 'Буфер',
};

export const STATUS_LABELS: Record<EventStatus, string> = {
  planned: 'Запланировано',
  notified: 'Напомнили',
  started: 'Начато',
  completed: 'Выполнено',
  snoozed: 'Отложено',
  rescheduled: 'Нужно перенести',
  skipped: 'Пропущено',
  unanswered: 'Без ответа',
  cancelled: 'Отменено',
};

export type TaskStatus = 'inbox' | 'todo' | 'scheduled' | 'in_progress' | 'waiting' | 'someday' | 'done' | 'cancelled';
export type TaskType = 'task' | 'reminder' | 'waiting' | 'idea' | 'wish' | 'event';
export type TaskCategory =
  | 'personal'
  | 'health'
  | 'finance'
  | 'household'
  | 'work_reminder'
  | 'own_project'
  | 'shopping'
  | 'idea'
  | 'wish'
  | 'event';

export const TASK_CATEGORY_LABELS: Record<TaskCategory, string> = {
  personal: 'Личное',
  health: 'Здоровье',
  finance: 'Финансы',
  household: 'Дом',
  work_reminder: 'Рабочее напоминание',
  own_project: 'Свой проект',
  shopping: 'Покупки',
  idea: 'Идея',
  wish: 'Желание',
  event: 'Событие',
};

export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  inbox: 'Входящие',
  todo: 'К выполнению',
  scheduled: 'Запланировано',
  in_progress: 'В работе',
  waiting: 'Ожидаю',
  someday: 'Когда-нибудь',
  done: 'Готово',
  cancelled: 'Отменено',
};

export type MealSlot = 'breakfast' | 'lunch' | 'dinner' | 'snack' | 'post_workout';
export const MEAL_SLOT_LABELS: Record<MealSlot, string> = {
  breakfast: 'Завтрак',
  lunch: 'Обед',
  dinner: 'Ужин',
  snack: 'Перекус',
  post_workout: 'После тренировки',
};

export function mealSlotOfKind(kind: string): MealSlot | null {
  switch (kind) {
    case 'meal_breakfast':
      return 'breakfast';
    case 'meal_lunch':
      return 'lunch';
    case 'meal_dinner':
      return 'dinner';
    case 'snack':
      return 'snack';
    default:
      return null;
  }
}

export type ConsumptionStatus = 'all' | 'part' | 'replaced' | 'not_eaten';
export const CONSUMPTION_LABELS: Record<ConsumptionStatus, string> = {
  all: 'Съел всё',
  part: 'Часть',
  replaced: 'Заменил блюдо',
  not_eaten: 'Не ел',
};

export type MetricType = 'weight' | 'steps' | 'sleep_minutes' | 'sleep_quality' | 'energy' | 'water_ml';
