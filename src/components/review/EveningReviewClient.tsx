'use client';
import { CalendarCheck, Check, ChevronDown, ChevronUp, Moon } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { DraftSuggestion, EveningView, MealDayStatus } from '@/server/services/review';
import { formatDateRu, formatDuration, relativeDayLabel, timeToMinutes, minutesToTime } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chips, Input, Textarea } from '@/components/ui/Field';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';
import { EventActionSheet, type UiEvent } from '@/components/events/EventActionSheet';
import { EventRow } from '@/components/events/EventRow';

const MEAL_TONE: Record<MealDayStatus, { label: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  confirmed: { label: 'отмечен', tone: 'ok' },
  skipped: { label: 'пропущен', tone: 'neutral' },
  unknown: { label: 'без ответа', tone: 'warn' },
  upcoming: { label: 'ещё впереди', tone: 'neutral' },
  not_planned: { label: 'не в плане', tone: 'neutral' },
};

const ENERGY = [
  { value: 1, label: '1 · без сил' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
  { value: 5, label: '5 · бодро' },
];

type ItemState = { selected: boolean; startTime: string; durationMinutes: number; editing: boolean };

export function EveningReviewClient({ view }: { view: EveningView }) {
  const router = useRouter();
  const toast = useToast();
  const { facts, tomorrow } = view;
  const saved = facts.review.answers;
  const [sheet, setSheet] = useState<{ e: UiEvent; mode: 'menu' | 'meal' } | null>(null);
  const [wins, setWins] = useState(saved?.wins ?? '');
  const [blockers, setBlockers] = useState(saved?.blockers ?? '');
  const [bed, setBed] = useState<boolean | null>(saved?.workedInBed ?? null);
  const [energy, setEnergy] = useState<number | null>(saved?.energy ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reviewed = !!facts.review.reviewedAt;
  const skipped = facts.review.skipped && !reviewed;
  const dayTitle = view.date === view.today ? 'сегодня' : formatDateRu(view.date);
  const tomorrowLabel = relativeDayLabel(tomorrow.date, view.today);
  const draftKey = `${tomorrow.date}:${tomorrow.status}:${tomorrow.suggestions.map((x) => `${x.id}@${x.slot?.startTime ?? ''}`).join(',')}`;

  async function run<T>(key: string, fn: () => Promise<T>, ok?: (r: T) => string) {
    setBusy(key);
    setError(null);
    try {
      const r = await fn();
      if (ok) toast.ok(ok(r));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const saveReview = () =>
    run(
      'save',
      () =>
        api<{ message: string }>('/api/review/evening', {
          body: { date: view.date, wins: wins.trim() || null, blockers: blockers.trim() || null, workedInBed: bed, energy },
        }),
      (r) => r.message,
    );
  const skipReview = () => run('skip', () => api<{ message: string }>('/api/review/evening/skip', { body: { date: view.date } }), (r) => r.message);

  return (
    <div className="space-y-5">
      <header className="space-y-1">
        <p className="text-sm text-muted">{formatDateRu(view.date, { long: true })}</p>
        <h1 className="text-2xl font-semibold leading-tight">Завершение дня</h1>
        <p className="text-[15px] text-muted">Пара вопросов и план на {tomorrowLabel.toLowerCase()}. Можно пропустить — ничего не сломается.</p>
        {reviewed ? <Badge tone="ok">Обзор за {dayTitle} сохранён</Badge> : skipped ? <Badge>Обзор за {dayTitle} пропущен</Badge> : null}
      </header>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      {/* unanswered quick answers */}
      {facts.unanswered.length ? (
        <Card className="p-4">
          <h2 className="font-medium">Без ответа: {facts.unanswered.length}</h2>
          <p className="mt-0.5 text-sm text-muted">Это «неизвестно», а не «пропущено». Отметь, как было на самом деле, — или оставь.</p>
          <ul className="mt-2 divide-y divide-border">
            {facts.unanswered.map((e) => (
              <li key={e.id}>
                <EventRow e={e} compact onOpen={(x) => setSheet({ e: x, mode: x.kind.startsWith('meal') ? 'meal' : 'menu' })} />
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {/* facts of the day */}
      <section aria-labelledby="day-facts" className="space-y-2">
        <h2 id="day-facts" className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">
          Как прошёл день — по отметкам
        </h2>
        <Card className="space-y-3 p-4 text-[15px]">
          <div className="flex flex-wrap gap-2">
            {facts.meals.map((m) => (
              <Badge key={m.slot} tone={MEAL_TONE[m.status].tone}>
                {m.label}: {MEAL_TONE[m.status].label}
              </Badge>
            ))}
          </div>
          {facts.events.tracked ? (
            <p>
              Выполнено {facts.events.completed} из {facts.events.tracked}
              {facts.events.skipped ? `, пропущено ${facts.events.skipped}` : ''}
              {facts.events.unknown ? `, без ответа ${facts.events.unknown}` : ''}
              {facts.events.upcoming ? `, ещё впереди ${facts.events.upcoming}` : ''}.
            </p>
          ) : (
            <p className="text-muted">В плане дня не было событий для отметки — нет данных.</p>
          )}
          {facts.extraWork.sessions ? (
            <p>
              Дополнительная работа: план {formatDuration(facts.extraWork.plannedMinutes)}, подтверждено{' '}
              {facts.extraWork.actualMinutes ? formatDuration(facts.extraWork.actualMinutes) : 'нет'}.
            </p>
          ) : null}
          {facts.workout.planned || facts.workout.sessionLogged ? (
            <p>
              Тренировка:{' '}
              {facts.workout.completed || facts.workout.sessionLogged
                ? 'выполнена'
                : facts.workout.skipped
                  ? 'пропущена'
                  : facts.workout.unknown
                    ? 'без ответа'
                    : 'ещё впереди'}
              .
            </p>
          ) : null}
        </Card>
      </section>

      {/* the 2–4 questions */}
      <section aria-labelledby="questions" className="space-y-2">
        <h2 id="questions" className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">
          Пара вопросов
        </h2>
        <Card className="space-y-4 p-4">
          <Textarea label="Что сегодня удалось?" placeholder="Необязательно, пара слов" value={wins} maxLength={500} onChange={(e) => setWins(e.target.value)} className="min-h-16" />
          <Textarea label="Что мешало?" placeholder="Например, созвоны после 17:00" value={blockers} maxLength={500} onChange={(e) => setBlockers(e.target.value)} className="min-h-16" />
          {view.askWorkInBed ? (
            <div className="space-y-1.5">
              <p className="text-sm font-medium">Сегодня не работал в кровати?</p>
              <Chips
                ariaLabel="Работа в кровати"
                options={[
                  { value: 'no', label: 'Да, не работал' },
                  { value: 'yes', label: 'Работал' },
                ]}
                value={bed === null ? [] : [bed ? 'yes' : 'no']}
                onChange={(v) => setBed(v[0] === undefined ? null : v[0] === 'yes')}
              />
            </div>
          ) : null}
          <div className="space-y-1.5">
            <p className="text-sm font-medium">Сколько сил осталось?</p>
            <Chips ariaLabel="Сколько сил осталось" options={ENERGY} value={energy === null ? [] : [energy]} onChange={(v) => setEnergy(v[0] ?? null)} />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button variant="primary" size="lg" loading={busy === 'save'} onClick={saveReview} icon={<Moon className="size-4" />} className="sm:flex-1">
              {reviewed ? 'Обновить ответы' : 'Завершить день'}
            </Button>
            {!reviewed ? (
              <Button variant="ghost" loading={busy === 'skip'} onClick={skipReview}>
                Пропустить обзор сегодня
              </Button>
            ) : null}
          </div>
        </Card>
      </section>

      <TomorrowSection key={draftKey} tomorrow={tomorrow} label={tomorrowLabel} onOpenEvent={(e) => setSheet({ e, mode: 'menu' })} />

      <EventActionSheet event={sheet?.e ?? null} initialMode={sheet?.mode ?? 'menu'} onClose={() => setSheet(null)} />
    </div>
  );
}

function TomorrowSection({ tomorrow, label: tomorrowLabel, onOpenEvent }: { tomorrow: EveningView['tomorrow']; label: string; onOpenEvent: (e: UiEvent) => void }) {
  const router = useRouter();
  const toast = useToast();
  const [items, setItems] = useState<Record<string, ItemState>>(() => itemsFrom(tomorrow.suggestions));
  const [showEvents, setShowEvents] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selected = tomorrow.suggestions.filter((s) => items[s.id]?.selected);
  const setItem = (id: string, patch: Partial<ItemState>) => setItems((x) => ({ ...x, [id]: { ...x[id]!, ...patch } }));

  async function run<T>(key: string, fn: () => Promise<T>, ok: (r: T) => string) {
    setBusy(key);
    setError(null);
    try {
      toast.ok(ok(await fn()));
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  const accept = (only?: DraftSuggestion) =>
    run(
      only ? `one:${only.id}` : 'accept',
      () =>
        api<{ message: string; warnings: string[] }>('/api/review/evening/tomorrow/accept', {
          body: {
            date: tomorrow.date,
            confirmDay: !only,
            items: (only ? [only] : selected)
              .filter((s) => items[s.id]?.startTime)
              .map((s) => ({ id: s.id, startTime: items[s.id]!.startTime, durationMinutes: items[s.id]!.durationMinutes })),
          },
        }),
      (r) => [r.message, ...r.warnings].join(' '),
    );
  const keep = () => run('keep', () => api<{ message: string }>('/api/review/evening/tomorrow/keep', { body: { date: tomorrow.date } }), (r) => r.message);

  return (
        <section aria-labelledby="tomorrow" className="space-y-2">
          <div className="flex items-center justify-between px-1">
            <h2 id="tomorrow" className="text-[13px] font-semibold uppercase tracking-wide text-muted">
              План на {tomorrowLabel.toLowerCase()} · {formatDateRu(tomorrow.date)}
            </h2>
            <Badge tone={tomorrow.status === 'draft' ? 'neutral' : 'ok'}>
              {tomorrow.status === 'confirmed' ? 'принят' : tomorrow.status === 'kept' ? 'без изменений' : 'черновик'}
            </Badge>
          </div>
          {error ? <Notice tone="danger">{error}</Notice> : null}
          <Card className="p-1.5">
            <button
              type="button"
              onClick={() => setShowEvents((v) => !v)}
              aria-expanded={showEvents}
              className="flex min-h-11 w-full items-center justify-between rounded-xl px-3 text-left text-[15px] hover:bg-surface-2"
            >
              <span>
                Уже в плане: {tomorrow.events.length} {tomorrow.events.length === 1 ? 'событие' : tomorrow.events.length < 5 ? 'события' : 'событий'}
              </span>
              {showEvents ? <ChevronUp className="size-4 text-muted" /> : <ChevronDown className="size-4 text-muted" />}
            </button>
            {showEvents ? (
              tomorrow.events.length ? (
                <ul>
                  {tomorrow.events.map((e) => (
                    <li key={e.id}>
                      <EventRow e={e} compact onOpen={onOpenEvent} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="px-3 pb-3 text-sm text-muted">Событий пока нет.</p>
              )
            ) : null}
          </Card>

          <Card className="p-4">
            <h3 className="font-medium">Предложения</h3>
            {tomorrow.suggestions.length ? (
              <>
                <p className="mt-0.5 text-sm text-muted">Каждое — с источником и свободным временем. Сними галочку или поменяй время, если не подходит.</p>
                <ul className="mt-3 space-y-2">
                  {tomorrow.suggestions.map((s) => (
                    <SuggestionItem
                      key={s.id}
                      s={s}
                      state={items[s.id]}
                      busy={busy === `one:${s.id}`}
                      onChange={(p) => setItem(s.id, p)}
                      onAcceptOne={() => accept(s)}
                    />
                  ))}
                </ul>
              </>
            ) : (
              <EmptyState title="Новых предложений нет" icon={<CalendarCheck className="size-6" />} className="py-6">
                День уже собран по твоим правилам: сроков, просрочек и переносов нет.
              </EmptyState>
            )}
            <div className="mt-4 flex flex-col gap-2 sm:flex-row">
              {tomorrow.suggestions.length ? (
                <Button variant="primary" size="lg" loading={busy === 'accept'} onClick={() => accept()} icon={<Check className="size-4" />} className="sm:flex-1">
                  {selected.length ? `Принять всё (${selected.length})` : 'Принять план'}
                </Button>
              ) : (
                <Button variant="primary" size="lg" loading={busy === 'accept'} onClick={() => accept()} disabled={tomorrow.status === 'confirmed'} className="sm:flex-1">
                  Принять план
                </Button>
              )}
              <Button loading={busy === 'keep'} onClick={keep} disabled={tomorrow.status !== 'draft'}>
                Оставить без изменений
              </Button>
            </div>
            <p className="mt-3 text-xs text-muted">Если не ответить — просто действуют текущие правила, ничего не удаляется и не сдвигается.</p>
          </Card>
          <Link href={`/plan?date=${tomorrow.date}`} className="flex min-h-11 items-center px-1 text-sm text-accent">
            Открыть {tomorrowLabel.toLowerCase()} в плане
          </Link>
        </section>
  );
}

function itemsFrom(list: DraftSuggestion[]): Record<string, ItemState> {
  return Object.fromEntries(list.map((s) => [s.id, { selected: s.selected && !!s.slot, startTime: s.slot?.startTime ?? '', durationMinutes: s.durationMinutes, editing: !s.slot }]));
}

function SuggestionItem({
  s,
  state,
  busy,
  onChange,
  onAcceptOne,
}: {
  s: DraftSuggestion;
  state: ItemState | undefined;
  busy: boolean;
  onChange: (p: Partial<ItemState>) => void;
  onAcceptOne: () => void;
}) {
  if (!state) return null;
  const end = state.startTime ? minutesToTime(timeToMinutes(state.startTime) + state.durationMinutes) : null;
  return (
    <li className={cn('rounded-xl border border-border p-3', state.selected ? 'bg-surface' : 'bg-surface-2/60')}>
      <div className="flex items-start gap-3">
        <button
          type="button"
          role="checkbox"
          aria-checked={state.selected}
          aria-label={`Включить «${s.title}» в план`}
          disabled={!state.startTime}
          onClick={() => onChange({ selected: !state.selected })}
          className="-m-2 grid size-11 shrink-0 place-items-center disabled:opacity-40"
        >
          <span className={cn('grid size-6 place-items-center rounded-md border', state.selected ? 'border-accent bg-accent text-accent-fg' : 'border-border bg-surface')}>
            {state.selected ? <Check className="size-4" /> : null}
          </span>
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-[15px] font-medium leading-snug">{s.title}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge tone={s.source === 'overdue' ? 'warn' : s.source === 'weekly_quota' ? 'accent' : 'neutral'}>{s.sourceLabel}</Badge>
            {s.detail ? <span>{s.detail}</span> : null}
          </div>
          {state.editing ? (
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <Input type="time" label="Начало" value={state.startTime} onChange={(e) => onChange({ startTime: e.target.value, selected: !!e.target.value })} className="w-32" />
              <Input
                type="number"
                label="Минут"
                inputMode="numeric"
                min={5}
                max={480}
                step={5}
                value={state.durationMinutes}
                onChange={(e) => onChange({ durationMinutes: Math.max(5, Math.min(480, Number(e.target.value) || 5)) })}
                className="w-24"
              />
            </div>
          ) : (
            <p className="tabular mt-1 text-sm">
              {state.startTime}–{end} · {formatDuration(state.durationMinutes)}
            </p>
          )}
          {!s.slot && !state.startTime ? <p className="mt-1 text-xs text-warn">Свободного окна не нашлось — укажи время сам.</p> : null}
          <div className="mt-2 flex flex-wrap gap-2">
            <Button size="sm" variant="ghost" onClick={() => onChange({ editing: !state.editing })}>
              {state.editing ? 'Готово' : 'Изменить'}
            </Button>
            <Button size="sm" variant="soft" loading={busy} disabled={!state.startTime} onClick={onAcceptOne} className="min-h-11 sm:min-h-9">
              Только это
            </Button>
          </div>
        </div>
      </div>
    </li>
  );
}
