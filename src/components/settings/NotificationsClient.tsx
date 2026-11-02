'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { InAppNotification } from '@/server/services/notifications';
import { formatDateRu, formatTime, localDateOf } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import { EmptyState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { openExtraWork } from '@/components/shell/events';
import { useClientUser } from '@/components/shell/UserContext';

export function NotificationsClient({ items }: { items: InAppNotification[] }) {
  const router = useRouter();
  const toast = useToast();
  const { tz } = useClientUser();
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    if (items.some((i) => !i.readAt)) {
      api('/api/notifications', { body: { ids: 'all' } })
        .then(() => router.refresh())
        .catch(() => {});
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(n: InAppNotification, b: InAppNotification['buttons'][number]) {
    if (b.action.type === 'open') return router.push(b.action.path);
    if (b.action.type === 'extra_work') return openExtraWork(b.action.minutes);
    if (!n.eventId) return;
    setBusy(`${n.id}:${b.label}`);
    try {
      const r = await api<{ message: string }>(`/api/plan/events/${n.eventId}/transition`, {
        body: { action: b.action.transition, ...(b.action.transition === 'snooze' ? { snoozeMinutes: 15 } : {}) },
      });
      toast.ok(r.message);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between">
        <h1 className="text-2xl font-semibold">Уведомления</h1>
        <Link href="/settings#notifications" className="text-sm text-accent">
          Настройки
        </Link>
      </header>
      {items.length ? (
        <Card className="divide-y divide-border">
          {items.map((n) => (
            <div key={n.id} className="px-4 py-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className={cn('text-[15px]', !n.readAt && 'font-semibold')}>{n.title}</p>
                  {n.body ? <p className="text-sm text-muted">{n.body}</p> : null}
                </div>
                <span className="tabular shrink-0 text-xs text-faint">
                  {n.sentAt ? `${formatDateRu(localDateOf(n.sentAt, tz))}, ${formatTime(n.sentAt, tz)}` : ''}
                </span>
              </div>
              {n.status === 'acknowledged' ? (
                <p className="mt-1 text-xs text-ok">Отвечено</p>
              ) : n.buttons.length ? (
                <div className="mt-2 flex flex-wrap gap-2">
                  {n.buttons.map((b) => (
                    <Button key={b.label} size="sm" loading={busy === `${n.id}:${b.label}`} onClick={() => act(n, b)}>
                      {b.label}
                    </Button>
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </Card>
      ) : (
        <Card>
          <EmptyState title="Пока не было уведомлений">Напоминания появятся здесь по плану дня. На телефон — через Telegram или push (настройки).</EmptyState>
        </Card>
      )}
    </div>
  );
}
