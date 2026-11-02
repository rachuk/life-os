'use client';
import { Briefcase, ChevronLeft, ChevronRight, Lock, Plus, Shield, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { addDays, formatDateRu, formatDuration, formatRange, formatTime, isoWeekday, localDateOf, relativeDayLabel, weekdayShort } from '@/domain/time';
import { CONTAINER_KINDS, type EventKind } from '@/domain/types';
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

/** Routine blocks are collapsed in the week view; variable ones are what the week is about. */
const ROUTINE: EventKind[] = ['work', 'morning_routine', 'meal_breakfast', 'meal_lunch', 'meal_dinner', 'snack', 'sleep', 'review'];

function freeGaps(events: UiEvent[]) {
  const live = events.filter((e) => !['cancelled', 'skipped'].includes(e.status) && e.kind !== 'sleep').sort((a, b) => a.startAt.localeCompare(b.startAt));
  const gaps: { start: string; end: string; minutes: number }[] = [];
  let cursor: string | null = null;
  for (const e of live) {
    if (cursor && e.startAt > cursor) {
      const minutes = Math.round((Date.parse(e.startAt) - Date.parse(cursor)) / 60000);
      if (minutes >= 30) gaps.push({ start: cursor, end: e.startAt, minutes });
    }
    if (!cursor || e.endAt > cursor) cursor = e.endAt;
  }
  return gaps;
}

function isNested(e: UiEvent, all: UiEvent[]): boolean {
  if (CONTAINER_KINDS.includes(e.kind)) return false;
  return all.some((c) => c.id !== e.id && CONTAINER_KINDS.includes(c.kind) && c.startAt <= e.startAt && c.endAt >= e.endAt && c.status !== 'cancelled');
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
  const gaps = useMemo(() => freeGaps(dayEvents), [dayEvents]);
  const p = data.progress;
  const weekEnd = addDays(data.weekStart, 6);
  const overtime = p.extraWorkMinutes.planned > p.extraWorkMinutes.warnAt;

  const goWeek = (delta: number) => {
    const w = addDays(data.weekStart, delta * 7);
    router.push(`/plan?week=${w}&view=${view}&date=${w}`);
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
    <div className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold">План</h1>
          <p className="text-sm text-muted">
            {formatDateRu(data.weekStart)} — {formatDateRu(weekEnd)}
          </p>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Предыдущая неделя" onClick={() => goWeek(-1)} className="grid size-11 place-items-center rounded-xl hover:bg-surface-2">
            <ChevronLeft className="size-5" />
          </button>
          <button type="button" onClick={() => router.push(`/plan?view=${view}`)} className="min-h-11 rounded-xl px-3 text-sm font-medium hover:bg-surface-2">
            Сегодня
          </button>
          <button type="button" aria-label="Следующая неделя" onClick={() => goWeek(1)} className="grid size-11 place-items-center rounded-xl hover:bg-surface-2">
            <ChevronRight className="size-5" />
          </button>
        </div>
      </header>

      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          ariaLabel="Вид"
          value={view}
          onChange={setView}
          options={[
            { value: 'day', label: 'День' },
            { value: 'week', label: 'Неделя' },
          ]}
        />
        <div className="ml-auto flex gap-2">
          <Button icon={<Briefcase className="size-4" />} onClick={() => openExtraWork()}>
            Нужно поработать
          </Button>
          <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => setAdding(true)} aria-label="Добавить событие">
            <span className="hidden sm:inline">Событие</span>
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted">
        Тренировки <b className="tabular font-semibold text-text">{p.workouts.completed}/{p.workouts.target}</b>
        {p.workouts.planned > p.workouts.completed ? ` (в плане ${p.workouts.planned})` : ''} · свои проекты{' '}
        <b className="tabular font-semibold text-text">{formatDuration(p.projectMinutes.completed)}</b> из {formatDuration(p.projectMinutes.target)} · переработки{' '}
        <b className={cn('tabular font-semibold', overtime ? 'text-warn' : 'text-text')}>{p.extraWorkMinutes.planned ? formatDuration(p.extraWorkMinutes.planned) : '0'}</b>
        {overtime ? ` — больше порога ${formatDuration(p.extraWorkMinutes.warnAt)}` : ''}
      </p>

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
            <h2 className="px-3 py-2 font-semibold">{date === today ? 'Сегодня' : formatDateRu(date, { long: true })}</h2>
            {dayEvents.length ? (
              <ul>
                {dayEvents.map((e) => (
                  <li key={e.id}>
                    <EventRow e={e as UiEvent} listDate={date} nested={isNested(e as UiEvent, dayEvents)} onOpen={setSheet} />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState title="Пока нет данных">План на этот день не строился — до начала использования дни пустые.</EmptyState>
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
          {days.map((d) => {
            const live = (d.events as UiEvent[]).filter((e) => e.status !== 'cancelled');
            const variable = live.filter((e) => !ROUTINE.includes(e.kind));
            const work = live.find((e) => e.kind === 'work');
            const meals = live.filter((e) => e.kind.startsWith('meal') || e.kind === 'snack').length;
            return (
              <Card key={d.date} className={cn('p-1.5 lg:min-h-56', d.date === today && 'ring-1 ring-accent')}>
                <button
                  type="button"
                  onClick={() => {
                    setDate(d.date);
                    setView('day');
                  }}
                  className="flex min-h-11 w-full items-baseline justify-between px-2 text-left"
                >
                  <span className="font-semibold">{relativeDayLabel(d.date, today) === 'Сегодня' ? 'Сегодня' : weekdayShort(isoWeekday(d.date))}</span>
                  <span className="tabular text-xs text-muted">
                    {d.date.slice(8)}.{d.date.slice(5, 7)}
                  </span>
                </button>
                {live.length ? (
                  <>
                    <p className="px-2 pb-1 text-xs text-muted">
                      {work ? `Работа ${formatRange(work.startAt, work.endAt, tz)}` : 'Выходной'}
                      {meals ? ` · еда ×${meals}` : ''}
                    </p>
                    {variable.length ? (
                      <ul className="space-y-0.5">
                        {variable.map((e) => (
                          <li key={e.id}>
                            <button
                              type="button"
                              onClick={() => setSheet(e)}
                              className={cn('flex min-h-11 w-full items-start gap-1.5 rounded-lg px-2 py-1 text-left text-[13px] hover:bg-surface-2', e.status === 'skipped' && 'opacity-50 line-through')}
                            >
                              <span className="mt-1.5 size-2 shrink-0 rounded-full" style={{ background: KIND_COLOR[e.kind] }} />
                              <span className="min-w-0">
                                <span className="tabular block text-xs text-muted">
                                  {localDateOf(e.startAt, tz) !== d.date ? `${weekdayShort(isoWeekday(localDateOf(e.startAt, tz)))} ` : ''}
                                  {formatTime(e.startAt, tz)}
                                </span>
                                <span className="line-clamp-2 block leading-snug">{e.title}</span>
                              </span>
                            </button>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="px-2 pb-1 text-xs text-muted">Только распорядок</p>
                    )}
                  </>
                ) : (
                  <p className="px-2 py-2 text-xs text-muted">Нет данных</p>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {data.versions.length ? (
        <section className="space-y-2">
          <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">История изменений недели</h2>
          <Card className="divide-y divide-border">
            {data.versions.map((v) => (
              <div key={v.id} className="flex items-center gap-3 px-4 py-2.5">
                <div className="min-w-0 flex-1">
                  <p className={cn('truncate text-sm', v.status === 'reverted' && 'text-muted line-through')}>{v.summary ?? SOURCE_LABELS[v.source] ?? v.source}</p>
                  <p className="text-xs text-muted">
                    {SOURCE_LABELS[v.source] ?? v.source} · {formatDateRu(localDateOf(v.createdAt, tz))} {formatTime(v.createdAt, tz)}
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

      <details className="rounded-2xl border border-border bg-surface px-4">
        <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm text-muted">Что значат значки</summary>
        <div className="space-y-1.5 pb-4 text-sm">
          <p className="flex items-center gap-2">
            <Lock className="size-3.5" /> неподвижное — подтверждённые встречи, не двигаются
          </p>
          <p className="flex items-center gap-2">
            <Shield className="size-3.5" /> защищённое — сон и еда: сдвигаются только в своём окне и никогда не сокращаются
          </p>
          <p className="text-muted">Тренировки, свои проекты и навыки переносятся в пределах недели; гибкие дела можно двигать и отменять.</p>
        </div>
      </details>

      <EventActionSheet event={sheet} onClose={() => setSheet(null)} />
      {adding ? <AddEventSheet open onClose={() => setAdding(false)} defaultDate={date} /> : null}
    </div>
  );
}
