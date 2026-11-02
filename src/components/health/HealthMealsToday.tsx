'use client';
import { Check } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { STATUS_LABELS } from '@/domain/types';
import { formatRange } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';
import { EventActionSheet, type UiEvent } from '@/components/events/EventActionSheet';
import { KIND_COLOR, statusTone } from '@/components/events/meta';

export interface PlannedDish {
  slot: string;
  title: string;
}

const SLOT_OF: Record<string, string> = { meal_breakfast: 'breakfast', meal_lunch: 'lunch', meal_dinner: 'dinner', snack: 'snack' };
const SETTLED = ['completed', 'skipped', 'cancelled'];

/**
 * Today's meals from the schedule. «Съел» is the ordinary one-tap answer (consumption «всё», with
 * «Отменить» in the toast); tapping the row opens the detailed answer — «Часть / Заменил / Не ел» and
 * what was eaten. A meal counts as eaten only after one of these explicit answers (HEALTH-03).
 */
export function HealthMealsToday({ events, dishes }: { events: UiEvent[]; dishes: Record<string, string> }) {
  const { tz } = useClientUser();
  const router = useRouter();
  const toast = useToast();
  const [sheet, setSheet] = useState<{ e: UiEvent; mode: 'menu' | 'meal' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  // optimistic «съел» until the refreshed server data arrives
  const [eaten, setEaten] = useState<Record<string, true>>({});

  async function undo(eventId: string, logId: string) {
    try {
      await api(`/api/meals/log/${logId}`, { method: 'DELETE' });
      toast.info('Отметка снята');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setEaten(({ [eventId]: _, ...rest }) => rest);
      router.refresh();
    }
  }

  async function ate(e: UiEvent) {
    setBusy(e.id);
    try {
      const r = await api<{ log: { id: string } }>('/api/meals/log', { body: { eventId: e.id, consumptionStatus: 'all' } });
      setEaten((x) => ({ ...x, [e.id]: true }));
      toast.ok(`${e.title}: съел`, { label: 'Отменить', onClick: () => void undo(e.id, r.log.id) });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!events.length) {
    return (
      <Card>
        <EmptyState
          title="Сегодня приёмы пищи не запланированы"
          action={
            <Link href="/health/meals" className="inline-flex min-h-11 items-center text-sm text-accent">
              Открыть меню
            </Link>
          }
        >
          Они появятся из распорядка дня. Отметить еду можно и в меню питания.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card className="p-1.5">
      <ul className="divide-y divide-border">
        {events.map((e) => {
          const settled = SETTLED.includes(e.status);
          const optimistic = !settled && eaten[e.id];
          const dish = dishes[SLOT_OF[e.kind] ?? ''];
          return (
            <li key={e.id} className="flex min-h-14 items-center gap-2 px-1.5 py-1">
              <button
                type="button"
                className="flex min-h-12 min-w-0 flex-1 items-center gap-3 rounded-xl px-1.5 text-left hover:bg-surface-2"
                onClick={() => setSheet({ e, mode: settled ? 'menu' : 'meal' })}
                aria-label={`${e.title}, ${formatRange(e.startAt, e.endAt, tz)}${settled ? `, ${STATUS_LABELS[e.status].toLowerCase()}` : ''}: ${settled ? 'изменить отметку' : 'подробнее — часть, заменил, не ел'}`}
              >
                <span aria-hidden="true" className="h-8 w-1 shrink-0 rounded-full" style={{ background: KIND_COLOR[e.kind], opacity: settled && e.status !== 'completed' ? 0.35 : 1 }} />
                <span className="min-w-0">
                  <span className="block truncate text-[15px]">{e.title}</span>
                  <span className="tabular block truncate text-xs text-muted">
                    {formatRange(e.startAt, e.endAt, tz)}
                    {dish ? ` · ${dish}` : ''}
                  </span>
                </span>
              </button>
              {settled ? (
                <Badge tone={statusTone(e.status)} className="mr-1.5 shrink-0">
                  {STATUS_LABELS[e.status]}
                </Badge>
              ) : optimistic ? (
                <Badge tone="ok" className="mr-1.5 shrink-0">
                  Съел
                </Badge>
              ) : (
                <Button size="md" variant="soft" className="shrink-0 px-3.5" loading={busy === e.id} icon={<Check className="size-4" />} onClick={() => ate(e)} aria-label={`${e.title}: съел`}>
                  Съел
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
