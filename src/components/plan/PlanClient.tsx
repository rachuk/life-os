'use client';
import { Briefcase, ChevronLeft, ChevronRight, Plus, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { addDays, formatDateRu, formatDuration, formatRange, formatTime, isoWeekday, relativeDayLabel, weekdayShort } from '@/domain/time';
import { PRIORITY_LABELS, type EventPriority } from '@/domain/types';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import { Segmented } from '@/components/ui/Segmented';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { EventActionSheet, type UiEvent } from '@/components/events/EventActionSheet';
import { EventRow } from '@/components/events/EventRow';
import { KIND_COLOR } from '@/components/events/meta';
import { openExtraWork } from '@/components/shell/events';
import { useClientUser } from '@/components/shell/UserContext';
import type { WeekData } from '@/server/views/plan';
import { AddEventSheet } from './AddEventSheet';

const SOURCE_LABELS: Record<string, string> = {
  extra_work: 'Переработка',
  undo: 'Отмена',
  snooze: 'Отложено',
  reschedule: 'Перенос',
  manual: 'Добавлено вручную',
  regenerate: 'Перестроено по распорядку',
  review: 'Обзор недели',
  day_plan: 'План дня',
};

function freeGaps(events: UiEvent[], date: string, tz: string) {
  const live = events
    .filter((e) => !['cancelled', 'skipped'].includes(e.status) && e.kind !== 'sleep')
    .sort((a, b) => a.startAt.localeCompare(b.startAt));
  const gaps: { start: string; end: string; minutes: number }[] = [];
  let cursor: string | null = null;
  for (const e of live) {
    if (cursor && e.startAt > cursor) {
      const minutes = Math.round((Date.parse(e.startAt) - Date.parse(cursor)) / 60000);
      if (minutes >= 30) gaps.push({ start: cursor, end: e.startAt, minutes });
    }
    if (!cursor || e.endAt > cursor) cursor = e.endAt;
  }
  void date;
  void tz;
  return gaps;
}

export function PlanClient({ data, today, initialDate, initialView }: { data: WeekData; today: string; initialDate: string; initialView: 'day' | 'week' }) {
  const router = useRouter();
  const toast = useToast();
  const { tz } = useClientUser();
  const [view, setView] = useState<'day' | 'week'>(initialView);
  const [date, setDate] = useState(initialDate);
  const [sheet, setSheet] = useState<UiEvent | null>(null);
  const [adding, setAdding] = useState(false);
  const [undoing, setUndoing] = useState<string | null>(null);

  const days = data.days;
  const dayEvents = useMemo(() => (days.find((d) => d.date === date)?.events ?? []) as UiEvent[], [days, date]);
  const gaps = useMemo(() => freeGaps(dayEvents, date, tz), [dayEvents, date, tz]);
  const p = data.progress;
  const weekEnd = addDays(data.weekStart, 6);

  const goWeek = (delta: number) => {
    const w = addDays(data.weekStart, delta * 7);
    router.push(`/plan?week=${w}&view=${view}${delta === 0 ? '' : `&date=${w}`}`);
  };

  async function undo(id: string) {
    setUndoing(id);
    try {
      const r = await api<{ skippedEventIds: string[] }>(`/api/plan/versions/${id}/undo`, { method: 'POST', body: {} });
      toast.ok(r.skippedEventIds.length ? `Отменено. ${r.skippedEventIds.length} событий уже менялись после — их не трогал.` : 'Изменения отменены, напоминания пересчитаны');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setUndoing(null);
    }
  }

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">План</h1>
          <p className="text-sm text-muted">
            {formatDateRu(data.weekStart)} — {formatDateRu(weekEnd)}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label="Предыдущая неделя" onClick={() => goWeek(-1)} icon={<ChevronLeft className="size-4" />} />
          <Button variant="ghost" size="sm" onClick={() => router.push(`/plan?view=${view}`)}>
            Сегодня
          </Button>
          <Button variant="ghost" size="sm" aria-label="Следующая неделя" onClick={() => goWeek(1)} icon={<ChevronRight className="size-4" />} />
        </div>
      </header>

      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Briefcase className="size-4" />} onClick={() => openExtraWork()}>
          Нужно поработать
        </Button>
        <Button icon={<Plus className="size-4" />} onClick={() => setAdding(true)}>
          Добавить событие
        </Button>
        <Segmented
          className="ml-auto"
          ariaLabel="Вид"
          value={view}
          onChange={setView}
          options={[
            { value: 'day', label: 'День' },
            { value: 'week', label: 'Неделя' },
          ]}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 text-sm">
        <Card className="p-3">
          <p className="text-xs text-muted">Тренировки</p>
          <p className="tabular font-semibold">
            {p.workouts.completed} / {p.workouts.target}
          </p>
          <p className="text-xs text-faint">в плане: {p.workouts.planned}</p>
        </Card>
        <Card className="p-3">
          <p className="text-xs text-muted">Свои проекты</p>
          <p className="tabular font-semibold">{formatDuration(p.projectMinutes.completed)}</p>
          <p className="text-xs text-faint">из {formatDuration(p.projectMinutes.target)}</p>
        </Card>
        <Card className={cn('p-3', p.extraWorkMinutes.planned > p.extraWorkMinutes.warnAt && 'border-warn')}>
          <p className="text-xs text-muted">Переработки</p>
          <p className="tabular font-semibold">{p.extraWorkMinutes.planned ? formatDuration(p.extraWorkMinutes.planned) : '0'}</p>
          <p className="text-xs text-faint">порог {formatDuration(p.extraWorkMinutes.warnAt)}</p>
        </Card>
      </div>

      {data.risks.map((r) => (
        <Notice key={r.message} tone="warn">
          {r.message}
        </Notice>
      ))}

      {view === 'day' ? (
        <>
          <div className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]" role="tablist" aria-label="День недели">
            {days.map((d) => (
              <button
                key={d.date}
                type="button"
                role="tab"
                aria-selected={d.date === date}
                onClick={() => setDate(d.date)}
                className={cn(
                  'flex min-h-14 min-w-12 flex-1 flex-col items-center justify-center rounded-xl text-sm',
                  d.date === date ? 'bg-accent text-accent-fg' : 'bg-surface text-text hover:bg-surface-2',
                  d.date === today && d.date !== date && 'ring-1 ring-accent',
                )}
              >
                <span className="text-xs opacity-80">{weekdayShort(isoWeekday(d.date))}</span>
                <span className="tabular font-semibold">{Number(d.date.slice(8))}</span>
              </button>
            ))}
          </div>
          <Card className="p-1.5">
            <div className="flex items-center justify-between px-3 py-2">
              <h2 className="font-semibold">{relativeDayLabel(date, today)}</h2>
              <span className="text-xs text-muted">{formatDateRu(date)}</span>
            </div>
            {dayEvents.length ? (
              <ul>
                {dayEvents.map((e) => (
                  <li key={e.id}>
                    <EventRow e={e as UiEvent} onOpen={setSheet} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Пока нет данных">План на этот день не строился (прошедшие дни до начала использования пусты).</EmptyState>
            )}
          </Card>
          {gaps.length ? (
            <Card className="p-4">
              <h3 className="text-sm font-semibold">Свободные окна</h3>
              <ul className="mt-2 flex flex-wrap gap-2">
                {gaps.map((g) => (
                  <li key={g.start} className="tabular rounded-full bg-surface-2 px-3 py-1 text-sm">
                    {formatRange(g.start, g.end, tz)} · {formatDuration(g.minutes)}
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </>
      ) : (
        <div className="grid gap-3 lg:grid-cols-7 lg:gap-2">
          {days.map((d) => (
            <Card key={d.date} className={cn('p-1.5 lg:min-h-64', d.date === today && 'ring-1 ring-accent')}>
              <button type="button" onClick={() => { setDate(d.date); setView('day'); }} className="flex w-full items-baseline justify-between px-2 py-1.5 text-left">
                <span className="font-semibold">{weekdayShort(isoWeekday(d.date))}</span>
                <span className="tabular text-xs text-muted">{d.date.slice(8)}.{d.date.slice(5, 7)}</span>
              </button>
              {d.events.filter((e) => e.kind !== 'sleep' && e.kind !== 'morning_routine').length ? (
                <ul className="space-y-0.5">
                  {d.events
                    .filter((e) => e.kind !== 'sleep' && e.kind !== 'morning_routine')
                    .map((e) => (
                      <li key={e.id}>
                        <button
                          type="button"
                          onClick={() => setSheet(e as UiEvent)}
                          className={cn('flex w-full items-start gap-1.5 rounded-lg px-2 py-1 text-left text-xs hover:bg-surface-2', ['cancelled', 'skipped'].includes(e.status) && 'opacity-40 line-through')}
                        >
                          <span className="mt-1 size-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[e.kind] }} />
                          <span className="min-w-0">
                            <span className="tabular block text-faint">{formatTime(e.startAt, tz)}</span>
                            <span className="block truncate">{e.title}</span>
                          </span>
                        </button>
                      </li>
                    ))}
                </ul>
              ) : (
                <p className="px-2 py-2 text-xs text-faint">Нет данных</p>
              )}
            </Card>
          ))}
        </div>
      )}

      <section className="space-y-2">
        <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">Типы блоков</h2>
        <Card className="grid gap-1 p-4 text-sm sm:grid-cols-2">
          {(Object.keys(PRIORITY_LABELS) as EventPriority[]).map((k) => (
            <p key={k}>
              <span className="font-medium">{PRIORITY_LABELS[k]}</span>
              <span className="text-muted">
                {' — '}
                {k === 'fixed' && 'работа и подтверждённые встречи, не двигаются'}
                {k === 'protected' && 'сон и еда: сдвигаются только в своих окнах, не сокращаются'}
                {k === 'required_movable' && 'тренировки и свои проекты: переносятся в пределах недели'}
                {k === 'flexible' && 'можно двигать и отменять'}
                {k === 'buffer' && 'запас на задержки'}
              </span>
            </p>
          ))}
        </Card>
      </section>

      {data.versions.length ? (
        <section className="space-y-2">
          <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">История изменений недели</h2>
          <Card className="divide-y divide-border">
            {data.versions.map((v) => (
              <div key={v.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-sm', v.status === 'reverted' && 'text-muted line-through')}>{v.summary ?? SOURCE_LABELS[v.source] ?? v.source}</p>
                  <p className="text-xs text-faint">
                    v{v.version} · {SOURCE_LABELS[v.source] ?? v.source} · {formatDateRu(v.createdAt.slice(0, 10))} {formatTime(v.createdAt, tz)}
                    {v.actor === 'telegram' ? ' · из Telegram' : ''}
                  </p>
                </div>
                {v.status === 'confirmed' && ['extra_work', 'reschedule', 'snooze', 'manual', 'review', 'day_plan'].includes(v.source) ? (
                  <Button size="sm" variant="ghost" loading={undoing === v.id} icon={<Undo2 className="size-4" />} onClick={() => undo(v.id)}>
                    Отменить
                  </Button>
                ) : null}
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      <EventActionSheet event={sheet} onClose={() => setSheet(null)} />
      {adding ? <AddEventSheet open onClose={() => setAdding(false)} defaultDate={date} /> : null}
    </div>
  );
}
