import type { EventKind, EventPriority, EventStatus } from '@/domain/types';

export const KIND_COLOR: Record<EventKind, string> = {
  work: 'var(--c-work)',
  extra_work: 'var(--c-extra)',
  morning_routine: 'var(--c-free)',
  meal_breakfast: 'var(--c-meal)',
  meal_lunch: 'var(--c-meal)',
  meal_dinner: 'var(--c-meal)',
  snack: 'var(--c-meal)',
  sleep: 'var(--c-sleep)',
  workout: 'var(--c-workout)',
  own_project: 'var(--c-project)',
  skill: 'var(--c-project)',
  task: 'var(--c-task)',
  review: 'var(--c-review)',
  weekly_review: 'var(--c-review)',
  free_time: 'var(--c-free)',
  custom: 'var(--c-task)',
};

export const PRIORITY_SHORT: Record<EventPriority, string> = {
  fixed: 'неподвижно',
  protected: 'защищено',
  required_movable: 'обязательно, можно двигать',
  flexible: 'гибко',
  buffer: 'буфер',
};

export function statusTone(s: EventStatus): 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' {
  if (s === 'completed') return 'ok';
  if (s === 'started') return 'accent';
  if (s === 'skipped' || s === 'cancelled') return 'neutral';
  if (s === 'unanswered' || s === 'rescheduled') return 'warn';
  return 'neutral';
}

export const SKIP_REASONS = ['Нет времени', 'Созвон', 'Устал', 'Плохо себя чувствую', 'Изменились планы'];
