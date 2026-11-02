import type { DateTime } from 'luxon';
import type { LocalDate, LocalTime } from '../time';
import type { EventKind, EventPriority, EventStatus } from '../types';

export interface PlanEvent {
  id: string;
  kind: EventKind;
  title: string;
  priorityClass: EventPriority;
  status: EventStatus;
  localDate: LocalDate;
  startAt: DateTime;
  endAt: DateTime;
  templateId: string | null;
  taskId: string | null;
  flexWindow: { earliest: LocalTime; latest: LocalTime } | null;
  originKey: string | null;
  source: string;
  revision: number;
}

/** Event to be inserted (no id yet). */
export interface NewEvent {
  kind: EventKind;
  title: string;
  priorityClass: EventPriority;
  localDate: LocalDate;
  startAt: DateTime;
  endAt: DateTime;
  templateId: string | null;
  taskId?: string | null;
  flexWindow: { earliest: LocalTime; latest: LocalTime } | null;
  originKey: string | null;
  source: string;
}

export interface Slot {
  startAt: DateTime;
  endAt: DateTime;
}

/** Events that occupy time (cancelled/skipped ones free their slot). */
export function occupiesTime(e: Pick<PlanEvent, 'status'>): boolean {
  return e.status !== 'cancelled' && e.status !== 'skipped' && e.status !== 'rescheduled';
}
