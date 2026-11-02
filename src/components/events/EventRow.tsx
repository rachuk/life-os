'use client';
import { ChevronRight } from 'lucide-react';
import { STATUS_LABELS } from '@/domain/types';
import { formatRange } from '@/domain/time';
import { cn } from '@/components/ui/cn';
import { useClientUser } from '@/components/shell/UserContext';
import type { UiEvent } from './EventActionSheet';
import { KIND_COLOR } from './meta';

export function EventRow({ e, onOpen, compact, highlight }: { e: UiEvent; onOpen: (e: UiEvent) => void; compact?: boolean; highlight?: boolean }) {
  const { tz } = useClientUser();
  const done = e.status === 'completed';
  const off = e.status === 'skipped' || e.status === 'cancelled';
  return (
    <button
      type="button"
      onClick={() => onOpen(e)}
      className={cn(
        'group flex w-full items-center gap-3 rounded-xl px-3 text-left transition-colors hover:bg-surface-2',
        compact ? 'min-h-11 py-1.5' : 'min-h-14 py-2',
        highlight && 'bg-accent-soft',
      )}
    >
      <span aria-hidden="true" className="h-8 w-1 shrink-0 rounded-full" style={{ background: KIND_COLOR[e.kind], opacity: off ? 0.35 : 1 }} />
      <span className="min-w-0 flex-1">
        <span className={cn('block truncate text-[15px]', done && 'text-muted line-through decoration-faint', off && 'text-faint line-through')}>{e.title}</span>
        <span className="tabular block text-xs text-muted">
          {formatRange(e.startAt, e.endAt, tz)}
          {e.status !== 'planned' ? ` · ${STATUS_LABELS[e.status]}` : ''}
          {e.priorityClass === 'protected' ? ' · защищено' : ''}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-faint opacity-0 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
