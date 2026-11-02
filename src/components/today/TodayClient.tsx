'use client';
import { Briefcase, CalendarCheck, Mic, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { NowAction } from '@/domain/planner/now';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { useToast } from '@/components/ui/Toaster';
import { EventActionSheet, type UiEvent } from '@/components/events/EventActionSheet';
import { EventRow } from '@/components/events/EventRow';
import { openCapture, openExtraWork } from '@/components/shell/events';
import { KIND_COLOR } from '@/components/events/meta';

export interface TodayClientProps {
  events: UiEvent[];
  now: { mode: string; headline: string; subline: string | null; currentId: string | null; nextIds: string[]; actions: NowAction[]; pendingIds: string[] };
  isToday: boolean;
}

export function TodayClient({ events, now, isToday }: TodayClientProps) {
  const router = useRouter();
  const toast = useToast();
  const [sheet, setSheet] = useState<{ e: UiEvent; mode: 'menu' | 'skip' | 'reschedule' | 'meal' } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [showPending, setShowPending] = useState(false);
  const byId = new Map(events.map((e) => [e.id, e]));
  const current = now.currentId ? byId.get(now.currentId) : undefined;
  const next = now.nextIds.map((id) => byId.get(id)).filter((e): e is UiEvent => !!e);
  const pending = now.pendingIds.map((id) => byId.get(id)).filter((e): e is UiEvent => !!e);

  async function run(a: NowAction) {
    const ev = a.eventId ? byId.get(a.eventId) : undefined;
    switch (a.kind) {
      case 'transition': {
        if (!ev || !a.transition) return;
        setBusy(a.id);
        try {
          const r = await api<{ message: string }>(`/api/plan/events/${ev.id}/transition`, {
            body: { action: a.transition, expectedRevision: ev.revision, ...(a.transition === 'snooze' ? { snoozeMinutes: 15 } : {}) },
          });
          toast.ok(r.message);
          router.refresh();
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(null);
        }
        return;
      }
      case 'extra_work':
        return openExtraWork();
      case 'capture':
        return openCapture();
      case 'open_plan':
        return router.push('/plan');
      case 'meal_log':
        return ev && setSheet({ e: ev, mode: 'meal' });
      case 'reschedule':
        return ev && setSheet({ e: ev, mode: ev.kind.startsWith('meal') ? 'skip' : 'reschedule' });
      case 'evening_review':
      case 'plan_tomorrow':
        return router.push('/review/evening');
      case 'open_workout':
        return router.push(`/workouts?event=${a.eventId ?? ''}`);
      case 'build_plan':
        setBusy(a.id);
        try {
          await api('/api/plan/generate', { body: { weekStart: events[0]?.localDate ?? new Date().toISOString().slice(0, 10) } });
          router.refresh();
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setBusy(null);
        }
    }
  }

  return (
    <>
      {/* «Сейчас» card */}
      <Card className="overflow-hidden">
        <div className="p-5">
          {current ? (
            <p className="mb-1 flex items-center gap-2 text-xs font-medium uppercase tracking-wide text-muted">
              <span className="size-2 rounded-full" style={{ background: KIND_COLOR[current.kind] }} /> Сейчас
            </p>
          ) : null}
          <h1 className="text-2xl font-semibold leading-tight">{isToday ? now.headline : 'План дня'}</h1>
          {now.subline && isToday ? <p className="mt-1 text-[15px] text-muted">{now.subline}</p> : null}
          {isToday ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {now.actions.slice(0, 3).map((a, i) => (
                <Button key={a.id} variant={i === 0 ? 'primary' : 'secondary'} size={i === 0 ? 'lg' : 'md'} loading={busy === a.id} onClick={() => run(a)} className={i === 0 ? 'min-w-40' : ''}>
                  {a.label}
                </Button>
              ))}
            </div>
          ) : null}
        </div>
        {current && current.kind !== 'work' ? (
          <button type="button" onClick={() => setSheet({ e: current, mode: 'menu' })} className="flex w-full min-h-11 items-center justify-between border-t border-border px-5 text-sm text-muted hover:bg-surface-2">
            Другие действия с «{current.title}» <span aria-hidden="true">›</span>
          </button>
        ) : null}
      </Card>

      {/* Unanswered decisions */}
      {pending.length ? (
        <Card className="p-4">
          <button type="button" onClick={() => setShowPending((v) => !v)} className="flex w-full min-h-11 items-center justify-between text-left" aria-expanded={showPending}>
            <span className="font-medium">
              Ответь на {pending.length} {pending.length === 1 ? 'событие' : pending.length < 5 ? 'события' : 'событий'}
            </span>
            <span className="text-sm text-accent">{showPending ? 'Скрыть' : 'Показать'}</span>
          </button>
          {showPending ? (
            <ul className="mt-2 divide-y divide-border">
              {pending.map((e) => (
                <li key={e.id}>
                  <EventRow e={e} onOpen={(x) => setSheet({ e: x, mode: x.kind.startsWith('meal') ? 'meal' : 'menu' })} compact />
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted">Без ответа — значит «неизвестно», а не «пропущено». Отметь, как было на самом деле.</p>
          )}
        </Card>
      ) : null}

      {/* Next blocks */}
      <section aria-labelledby="next-title" className="space-y-2">
        <div className="flex items-center justify-between px-1">
          <h2 id="next-title" className="text-[13px] font-semibold uppercase tracking-wide text-muted">
            {isToday ? 'Дальше по плану' : 'События дня'}
          </h2>
          <Link href="/plan" className="text-sm text-accent">
            Весь план
          </Link>
        </div>
        <Card className="p-1.5">
          {(isToday ? next : events).length ? (
            <ul>
              {(isToday ? next : events).map((e) => (
                <li key={e.id}>
                  <EventRow e={e} onOpen={(x) => setSheet({ e: x, mode: 'menu' })} />
                </li>
              ))}
            </ul>
          ) : (
            <p className="px-3 py-4 text-sm text-muted">На сегодня дальше ничего не запланировано.</p>
          )}
        </Card>
      </section>

      {/* Quick input */}
      <div className="grid grid-cols-3 gap-2">
        <button type="button" onClick={() => openCapture()} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-surface text-sm hover:bg-surface-2">
          <Plus className="size-5" /> Мысль
        </button>
        <button type="button" onClick={() => openCapture()} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-surface text-sm hover:bg-surface-2">
          <Mic className="size-5" /> Голос
        </button>
        <button type="button" onClick={() => openExtraWork()} className="flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl border border-border bg-surface text-sm hover:bg-surface-2">
          <Briefcase className="size-5" /> Поработать
        </button>
      </div>
      <Link href="/review/evening" className="flex min-h-12 items-center gap-2 rounded-2xl px-2 text-sm text-muted hover:text-text">
        <CalendarCheck className="size-4" /> Завершить день и план на завтра
      </Link>

      <EventActionSheet event={sheet?.e ?? null} initialMode={sheet?.mode ?? 'menu'} onClose={() => setSheet(null)} />
    </>
  );
}
