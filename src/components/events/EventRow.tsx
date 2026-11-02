'use client';
import { ChevronRight, Lock, Shield } from 'lucide-react';
import { STATUS_LABELS } from '@/domain/types';
import { formatRange, isoWeekday, localDateOf, weekdayShort } from '@/domain/time';
import { cn } from '@/components/ui/cn';
import { useClientUser } from '@/components/shell/UserContext';
import type { UiEvent } from './EventActionSheet';
import { KIND_COLOR } from './meta';

/**
 * One plan line. `listDate` = the day the list is about: an event starting on another local date
 * (e.g. the night that begins after midnight) shows its weekday so «Сон 00:00» is never ambiguous.
 * `nested` = the event sits inside a container (lunch inside work) and is indented.
 */
export function EventRow({
  e,
  onOpen,
  compact,
  highlight,
  listDate,
  nested,
}: {
  e: UiEvent;
  onOpen: (e: UiEvent) => void;
  compact?: boolean;
  highlight?: boolean;
  listDate?: string;
  nested?: boolean;
}) {
  const { tz } = useClientUser();
  const done = e.status === 'completed';
  const off = e.status === 'skipped' || e.status === 'cancelled';
  const startDate = localDateOf(e.startAt, tz);
  const otherDay = listDate && startDate !== listDate ? `${weekdayShort(isoWeekday(startDate))} ` : '';
  return (
    <button
      type="button"
      onClick={() => onOpen(e)}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl px-3 text-left transition-colors hover:bg-surface-2',
        compact ? 'min-h-11 py-1.5' : 'min-h-14 py-2',
        highlight && 'bg-accent-soft',
        nested && 'pl-7',
      )}
    >
      <span aria-hidden="true" className={cn('w-1 shrink-0 rounded-full', nested ? 'h-6' : 'h-8')} style={{ background: KIND_COLOR[e.kind], opacity: off ? 0.35 : 1 }} />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[15px]', done && 'text-muted line-through decoration-faint', off && 'text-faint line-through')}>{e.title}</span>
        <span className="tabular flex items-center gap-1 text-xs text-muted">
          {otherDay}
          {formatRange(e.startAt, e.endAt, tz)}
          {e.status !== 'planned' ? ` · ${STATUS_LABELS[e.status]}` : ''}
          {e.priorityClass === 'protected' ? <Shield aria-label="защищено" className="ml-0.5 size-3" /> : null}
          {e.priorityClass === 'fixed' && e.kind !== 'work' ? <Lock aria-label="неподвижно" className="ml-0.5 size-3" /> : null}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
