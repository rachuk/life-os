'use client';
import { CheckCircle2, Dumbbell } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { EXERCISE_BY_KEY } from '@/domain/fitness/catalog';
import { STATUS_LABELS } from '@/domain/types';
import { formatDateRu, formatRange, formatTime, isoWeekday, weekdayShort } from '@/domain/time';
import type { WorkoutOverview } from '@/server/services/workouts';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { Chips, Input, Switch, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';
import { useClientUser } from '@/components/shell/UserContext';
import { statusTone } from '@/components/events/meta';
import { ActiveSession, fmtSet } from './ActiveSession';
import { fmtKg } from './format';
import { Suggestion } from './Suggestion';

type Ev = WorkoutOverview['weekEvents'][number];
const SETTLED = ['completed', 'skipped', 'cancelled'];
const isOpen = (e: Ev) => !SETTLED.includes(e.status) && e.status !== 'started';

/** «вт 21:00» */
function shortWhen(e: Ev, tz: string) {
  return `${weekdayShort(isoWeekday(e.localDate)).toLowerCase()} ${formatTime(e.startAt, tz)}`;
}

/**
 * A workout done without a plan link while a planned one is still open this week: offer to count it
 * instead of that one (the nearest upcoming, else the latest past one), so the week is not counted twice.
 */
function replaceCandidate(o: WorkoutOverview): Ev | null {
  const open = o.weekEvents.filter(isOpen).sort((a, b) => a.startAt.localeCompare(b.startAt));
  return open.find((e) => e.localDate >= o.today) ?? open.filter((e) => e.localDate < o.today).at(-1) ?? null;
}

/** «Засчитать вместо вт 21:00?» — answered once per start / quick log. */
function ReplaceQuestion({ candidate, busy, onAnswer }: { candidate: Ev; busy: 'yes' | 'no' | null; onAnswer: (replace: boolean) => void }) {
  const { tz } = useClientUser();
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        В плане на этой неделе ещё стоит тренировка — {formatDateRu(candidate.localDate)}, {formatRange(candidate.startAt, candidate.endAt, tz)}. Если эта вместо неё, план отметится выполненным и в цели недели не задвоится.
      </p>
      <div className="grid gap-2 sm:grid-cols-2">
        <Button variant="primary" loading={busy === 'yes'} disabled={busy === 'no'} onClick={() => onAnswer(true)}>
          Да, вместо неё
        </Button>
        <Button variant="secondary" loading={busy === 'no'} disabled={busy === 'yes'} onClick={() => onAnswer(false)}>
          Нет, это дополнительная
        </Button>
      </div>
    </div>
  );
}

function WeekTarget({ o, current }: { o: WorkoutOverview; current: string | null }) {
  const { tz } = useClientUser();
  const { target, completed } = o.progress;
  const pct = target ? Math.min(100, Math.round((completed / target) * 100)) : 0;
  return (
    <Card className="p-4">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm text-muted">Цель недели</p>
        <p className="text-lg font-semibold">
          {completed} из {target}
        </p>
      </div>
      <div className="mt-2 h-2 overflow-hidden rounded-full bg-accent-soft" role="meter" aria-valuemin={0} aria-valuemax={target} aria-valuenow={completed} aria-label="Тренировки за неделю">
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
      {o.weekEvents.length ? (
        <ul className="mt-3 divide-y divide-border">
          {o.weekEvents.map((e) => (
            <li key={e.id}>
              <Link href={`/workouts?event=${e.id}`} className={cn('flex min-h-11 items-center justify-between gap-2 rounded-lg px-2 hover:bg-surface-2', e.id === current && 'bg-accent-soft')}>
                <span className="tabular min-w-0 text-sm">
                  {formatDateRu(e.localDate)}, {formatTime(e.startAt, tz)}
                </span>
                <Badge tone={statusTone(e.status)} className="shrink-0 whitespace-nowrap">
                  {STATUS_LABELS[e.status]}
                </Badge>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">На этой неделе тренировки в плане не стоят. Можно отметить тренировку и без плана — она засчитается.</p>
      )}
    </Card>
  );
}

function QuickLogSheet({ open, onClose, linkable, candidate }: { open: boolean; onClose: () => void; linkable: Ev | null; candidate: Ev | null }) {
  const router = useRouter();
  const toast = useToast();
  const { tz } = useClientUser();
  const [duration, setDuration] = useState('60');
  const [effort, setEffort] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [link, setLink] = useState(!!linkable);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<'save' | 'yes' | 'no' | null>(null);
  const [error, setError] = useState<string | null>(null);

  function validDuration(): number | null {
    const d = Number(duration);
    if (!Number.isInteger(d) || d < 5 || d > 600) {
      setError('Длительность — минуты от 5 до 600');
      return null;
    }
    return d;
  }

  function onSave() {
    if (validDuration() === null) return;
    if (!(link && linkable) && candidate) return setAsking(true);
    void save(link && linkable ? linkable.id : null, 'save');
  }

  async function save(eventId: string | null, key: 'save' | 'yes' | 'no') {
    const d = validDuration();
    if (d === null) return;
    setBusy(key);
    setError(null);
    try {
      const r = await api<{ changed: boolean; warnings: string[] }>('/api/workouts/quick', {
        body: { durationMinutes: d, perceivedEffort: effort, notes: notes.trim() || null, eventId },
      });
      toast.ok(r.changed ? ['Тренировка засчитана', ...r.warnings].join(' ') : 'Эта тренировка уже записана');
      onClose();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      setAsking(false);
    } finally {
      setBusy(null);
    }
  }

  if (asking && candidate) {
    return (
      <Sheet open={open} onClose={onClose} title={`Засчитать вместо ${shortWhen(candidate, tz)}?`}>
        <ReplaceQuestion candidate={candidate} busy={busy === 'yes' || busy === 'no' ? busy : null} onAnswer={(yes) => void save(yes ? candidate.id : null, yes ? 'yes' : 'no')} />
      </Sheet>
    );
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Тренировка состоялась"
      description="Без подходов — просто отметка и длительность."
      footer={
        <Button variant="primary" block loading={busy === 'save'} onClick={onSave}>
          Отметить
        </Button>
      }
    >
      <div className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Input label="Длительность, мин" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
        {linkable ? (
          <Switch
            checked={link}
            onChange={setLink}
            label="Это запланированная тренировка"
            description={`${formatDateRu(linkable.localDate)}, ${formatRange(linkable.startAt, linkable.endAt, tz)} — отметится выполненной`}
          />
        ) : null}
        <div>
          <p className="mb-1.5 text-sm font-medium">Насколько тяжело (необязательно)</p>
          <Chips ariaLabel="Субъективная сложность" options={Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} value={effort ? [effort] : []} onChange={(v) => setEffort(v[0] === effort ? null : (v[0] ?? null))} />
        </div>
        <Textarea label="Заметки" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="по желанию" />
      </div>
    </Sheet>
  );
}

function StartCard({ o, linkable }: { o: WorkoutOverview; linkable: Ev | null }) {
  const router = useRouter();
  const toast = useToast();
  const { tz } = useClientUser();
  const [routine, setRoutine] = useState(o.suggestedRoutineKey);
  const [link, setLink] = useState(!!linkable);
  const [busy, setBusy] = useState<'start' | 'yes' | 'no' | null>(null);
  const [asking, setAsking] = useState(false);
  const [quick, setQuick] = useState(false);
  const [quickKey, setQuickKey] = useState(0);
  const chosen = o.plan.choices.find((r) => r.key === routine) ?? o.plan.choices[0];
  // only when nothing is linked yet: an explicit «Привязать к плану» switch already answered the question
  const candidate = linkable ? null : replaceCandidate(o);

  function onStart() {
    if (!(link && linkable) && candidate) return setAsking(true);
    void start(link && linkable ? linkable.id : null, 'start');
  }

  async function start(eventId: string | null, key: 'start' | 'yes' | 'no') {
    setBusy(key);
    try {
      const r = await api<{ resumed: boolean; warnings: string[] }>('/api/workouts/sessions', { body: { routineKey: routine, eventId } });
      toast.ok([r.resumed ? 'Продолжаем начатую тренировку' : 'Тренировка начата', ...r.warnings].join(' '));
      setAsking(false);
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
      setAsking(false);
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-4">
      <p className="mb-2 text-sm font-medium">Что делаем сегодня</p>
      <Chips
        ariaLabel="Программа"
        options={o.plan.choices.map((r) => ({ value: r.key, label: r.key === o.suggestedRoutineKey ? `${r.name} · по очереди` : r.name }))}
        value={[routine]}
        onChange={(v) => v[0] && setRoutine(v[0])}
      />
      {chosen ? (
        <ul className="mt-3 space-y-1 text-sm">
          {chosen.exercises.map((e) => {
            const view = o.exercises[e.exerciseKey];
            return (
              <li key={e.exerciseKey} className="flex justify-between gap-2">
                <span className="min-w-0">{EXERCISE_BY_KEY[e.exerciseKey]?.name}</span>
                <span className="tabular shrink-0 text-muted">
                  {e.sets} × {e.repsMin}–{e.repsMax}
                  {e.unit === 'seconds' ? ' с' : ''}
                  {view?.prefill.weightKg ? ` · ${fmtKg(view.prefill.weightKg)} кг` : ''}
                </span>
              </li>
            );
          })}
        </ul>
      ) : null}
      {linkable ? (
        <div className="mt-3 border-t border-border pt-2">
          <Switch checked={link} onChange={setLink} label="Привязать к плану" description={`${formatDateRu(linkable.localDate)}, ${formatRange(linkable.startAt, linkable.endAt, tz)} — статус «начато», после завершения «выполнено»`} />
        </div>
      ) : null}
      <div className="mt-3 grid gap-2 sm:grid-cols-2">
        <Button variant="primary" size="lg" loading={busy === 'start'} onClick={onStart} icon={<Dumbbell className="size-5" />}>
          Начать тренировку
        </Button>
        <Button
          variant="secondary"
          size="lg"
          icon={<CheckCircle2 className="size-5" />}
          onClick={() => {
            setQuickKey((k) => k + 1);
            setQuick(true);
          }}
        >
          Тренировка состоялась
        </Button>
      </div>
      {o.plan.notes ? <p className="mt-3 text-xs text-muted">{o.plan.notes}</p> : null}
      <QuickLogSheet key={quickKey} open={quick} onClose={() => setQuick(false)} linkable={linkable} candidate={candidate} />
      <Sheet open={asking && !!candidate} onClose={() => setAsking(false)} title={candidate ? `Засчитать вместо ${shortWhen(candidate, tz)}?` : ''}>
        {candidate ? <ReplaceQuestion candidate={candidate} busy={busy === 'yes' || busy === 'no' ? busy : null} onAnswer={(yes) => void start(yes ? candidate.id : null, yes ? 'yes' : 'no')} /> : null}
      </Sheet>
    </Card>
  );
}

function History({ o }: { o: WorkoutOverview }) {
  const [openId, setOpenId] = useState<string | null>(null);
  const name = (key: string | null) => (key === 'quick' ? 'Отметка без подходов' : (o.plan.choices.find((r) => r.key === key)?.name ?? 'Тренировка'));
  if (!o.history.length) {
    return (
      <Card>
        <EmptyState title="Пока нет записанных тренировок" icon={<Dumbbell className="size-6" />}>
          Начни тренировку или отметь «Тренировка состоялась» — она появится здесь.
        </EmptyState>
      </Card>
    );
  }
  return (
    <Card className="p-1.5">
      <ul className="divide-y divide-border">
        {o.history.map((h) => (
          <li key={h.id}>
            <button type="button" onClick={() => setOpenId(openId === h.id ? null : h.id)} aria-expanded={openId === h.id} disabled={!h.setCount} className="flex min-h-14 w-full items-center justify-between gap-3 px-3 py-2 text-left disabled:cursor-default">
              <span className="min-w-0">
                <span className="block text-[15px]">{name(h.routineKey)}</span>
                <span className="block text-xs text-muted">
                  {formatDateRu(h.localDate)}
                  {h.durationMinutes ? ` · ${h.durationMinutes} мин` : ''}
                  {h.perceivedEffort ? ` · сложность ${h.perceivedEffort}/10` : ''}
                  {h.setCount ? ` · ${h.setCount} подх.` : ''}
                </span>
              </span>
              {h.scheduleEventId ? <Badge tone="ok" className="shrink-0 whitespace-nowrap">по плану</Badge> : <Badge className="shrink-0 whitespace-nowrap">вне плана</Badge>}
            </button>
            {openId === h.id ? (
              <div className="space-y-1 px-3 pb-3 text-sm">
                {h.exercises.map((k) => (
                  <p key={k}>
                    <span className="font-medium">{EXERCISE_BY_KEY[k]?.name ?? k}:</span>{' '}
                    <span className="tabular text-muted">
                      {h.sets
                        .filter((s) => s.exerciseKey === k)
                        .map((s) => fmtSet(s, o.exercises[k]?.unit ?? 'reps'))
                        .join(', ')}
                    </span>
                  </p>
                ))}
                {h.notes ? <p className="text-muted">«{h.notes}»</p> : null}
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function WorkoutsClient({ o }: { o: WorkoutOverview }) {
  const { tz } = useClientUser();
  const ev = o.event;
  const evDone = !!o.eventSession && o.eventSession.status === 'completed';
  const todayEvent = o.weekEvents.find((e) => e.localDate === o.today && !SETTLED.includes(e.status) && e.status !== 'started') ?? null;
  const linkable: Ev | null = ev ? (SETTLED.includes(ev.status) || evDone ? null : ev) : todayEvent;
  const offers = Object.values(o.exercises)
    .map((x) => x.offer)
    .filter((x): x is NonNullable<typeof x> => !!x && x.action !== 'keep');
  const routine = o.active ? (o.plan.choices.find((r) => r.key === o.active!.routineKey) ?? null) : null;

  return (
    <div className="space-y-6">
      {o.eventMissing ? <Notice tone="warn">Эта тренировка не найдена в плане — возможно, её удалили. Можно начать без привязки.</Notice> : null}
      {ev ? (
        <Card className="border-accent p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">Из плана</p>
          <p className="mt-0.5 font-semibold">
            {ev.title} · {formatDateRu(ev.localDate)}, {formatRange(ev.startAt, ev.endAt, tz)}
          </p>
          <div className="mt-1.5 flex flex-wrap items-center gap-2">
            <Badge tone={statusTone(ev.status)}>{STATUS_LABELS[ev.status]}</Badge>
            {evDone ? <span className="text-sm text-muted">Уже записана{o.eventSession?.durationMinutes ? `: ${o.eventSession.durationMinutes} мин` : ''}.</span> : null}
            {!evDone && (ev.status === 'skipped' || ev.status === 'cancelled') ? <span className="text-sm text-muted">Отмечена как {STATUS_LABELS[ev.status].toLowerCase()} — сними отметку в плане, если всё-таки была.</span> : null}
          </div>
        </Card>
      ) : null}

      {o.active ? (
        <ActiveSession overview={o} routine={routine} />
      ) : (
        <>
          <WeekTarget o={o} current={ev?.id ?? null} />
          <StartCard key={`${o.suggestedRoutineKey}:${linkable?.id ?? ''}`} o={o} linkable={linkable} />
        </>
      )}

      {!o.active && offers.length ? (
        <Section title="Рекомендации по весу">
          <div className="space-y-2">
            {offers.map((x) => (
              <Suggestion key={`${x.exerciseKey}:${x.basedOnSessionId}`} offer={x} showName />
            ))}
            <p className="px-1 text-xs text-muted">Это только предложения по записанным подходам. Учитывай самочувствие и технику; при боли нагрузку не повышай.</p>
          </div>
        </Section>
      ) : null}

      {o.active ? <WeekTarget o={o} current={ev?.id ?? null} /> : null}

      <Section title="История">
        <History o={o} />
      </Section>
    </div>
  );
}
