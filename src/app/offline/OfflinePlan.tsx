'use client';
import { RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { formatDateRu, formatRange } from '@/domain/time';
import { STATUS_LABELS, type EventStatus } from '@/domain/types';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { EmptyState, Skeleton } from '@/components/ui/States';

interface Snapshot {
  date: string;
  tz: string;
  nowIso: string;
  events: { id: string; startAt: string; endAt: string; title: string; status: EventStatus }[];
}

const DATA_CACHE = 'lifeos-data-v1';

export function OfflinePlan() {
  const [state, setState] = useState<{ loading: boolean; data: Snapshot | null; savedAt: string | null }>({ loading: true, data: null, savedAt: null });

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (!('caches' in window)) throw new Error('no caches');
        const cache = await caches.open(DATA_CACHE);
        const res = await cache.match('/api/today');
        const data = res ? ((await res.json()) as Snapshot) : null;
        if (alive) setState({ loading: false, data: data && Array.isArray(data.events) ? data : null, savedAt: res?.headers.get('date') ?? null });
      } catch {
        if (alive) setState({ loading: false, data: null, savedAt: null });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const retry = (
    <Button variant="primary" icon={<RefreshCw className="size-4" />} onClick={() => window.location.replace('/today')}>
      Попробовать снова
    </Button>
  );

  if (state.loading) return <Skeleton className="h-40 w-full" />;
  if (!state.data) {
    return (
      <Card>
        <EmptyState title="Сохранённого плана нет" action={retry}>
          План появится здесь после того, как ты хотя бы раз откроешь «Сегодня» с интернетом (при установленном приложении).
        </EmptyState>
      </Card>
    );
  }
  const d = state.data;
  const events = d.events.filter((e) => e.status !== 'cancelled');
  return (
    <div className="space-y-3">
      <Card className="p-4">
        <p className="text-sm font-medium">{formatDateRu(d.date, { long: true })}</p>
        {state.savedAt ? <p className="text-xs text-muted">Сохранено: {new Date(state.savedAt).toLocaleString('ru-RU', { timeZone: d.tz })}</p> : null}
        {events.length ? (
          <ul className="mt-3 divide-y divide-border">
            {events.map((e) => (
              <li key={e.id} className="flex min-h-11 items-center justify-between gap-3 py-2">
                <span className="min-w-0">
                  <span className="tabular block text-sm text-muted">{formatRange(e.startAt, e.endAt, d.tz)}</span>
                  <span className="block truncate text-[15px]">{e.title}</span>
                </span>
                {e.status !== 'planned' ? <span className="shrink-0 text-xs text-muted">{STATUS_LABELS[e.status]}</span> : null}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-muted">В сохранённом плане нет событий.</p>
        )}
      </Card>
      <div className="flex justify-center">{retry}</div>
    </div>
  );
}
