'use client';
import Link from 'next/link';
import { useState } from 'react';
import { STATUS_LABELS } from '@/domain/types';
import { formatRange } from '@/domain/time';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { useClientUser } from '@/components/shell/UserContext';
import { EventActionSheet, type UiEvent } from '@/components/events/EventActionSheet';
import { KIND_COLOR, statusTone } from '@/components/events/meta';

export interface PlannedDish {
  slot: string;
  title: string;
}

/**
 * Today's meals from the schedule. «Отметить» opens the event sheet in meal mode: the meal counts as
 * eaten only after the explicit «Съел всё / Часть / Заменил / Не ел» answer (HEALTH-03).
 */
export function HealthMealsToday({ events, dishes }: { events: UiEvent[]; dishes: Record<string, string> }) {
  const { tz } = useClientUser();
  const [sheet, setSheet] = useState<{ e: UiEvent; mode: 'menu' | 'meal' } | null>(null);
  const SLOT_OF: Record<string, string> = { meal_breakfast: 'breakfast', meal_lunch: 'lunch', meal_dinner: 'dinner', snack: 'snack' };

  if (!events.length) {
    return (
      <Card>
        <EmptyState title="Сегодня приёмы пищи не запланированы" action={<Link href="/health/meals" className="text-sm text-accent">Открыть меню</Link>}>
          Они появятся из распорядка дня. Отметить еду можно и в меню питания.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card className="p-1.5">
      <ul className="divide-y divide-border">
        {events.map((e) => {
          const settled = ['completed', 'skipped', 'cancelled'].includes(e.status);
          const dish = dishes[SLOT_OF[e.kind] ?? ''];
          return (
            <li key={e.id} className="flex min-h-14 items-center gap-3 px-3 py-2">
              <span aria-hidden="true" className="h-8 w-1 shrink-0 rounded-full" style={{ background: KIND_COLOR[e.kind], opacity: settled && e.status !== 'completed' ? 0.35 : 1 }} />
              <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSheet({ e, mode: 'menu' })}>
                <span className="block truncate text-[15px]">{e.title}</span>
                <span className="tabular block truncate text-xs text-muted">
                  {formatRange(e.startAt, e.endAt, tz)}
                  {dish ? ` · ${dish}` : ''}
                </span>
              </button>
              {settled ? (
                <Badge tone={statusTone(e.status)}>{STATUS_LABELS[e.status]}</Badge>
              ) : (
                <Button size="md" variant="soft" onClick={() => setSheet({ e, mode: 'meal' })}>
                  Отметить
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      <EventActionSheet event={sheet?.e ?? null} initialMode={sheet?.mode ?? 'menu'} onClose={() => setSheet(null)} />
    </Card>
  );
}
