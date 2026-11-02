'use client';
import { ChevronDown, Plus, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { EXERCISES, EXERCISE_BY_KEY, type Routine } from '@/domain/fitness/catalog';
import { formatDateShortRu, formatTime } from '@/domain/time';
import type { SerializedSession, SerializedSet, WorkoutOverview } from '@/server/services/workouts';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chips, Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';
import { RestTimer, type RestTimerHandle } from './RestTimer';
import { Suggestion } from './Suggestion';

type ExerciseView = WorkoutOverview['exercises'][string];

export function fmtSet(s: { actualReps: number | null; weightKg: number | null; rpe?: number | null }, unit: 'reps' | 'seconds') {
  const reps = s.actualReps === null ? '—' : unit === 'seconds' ? `${s.actualReps} с` : String(s.actualReps);
  const w = s.weightKg ? ` × ${s.weightKg} кг` : '';
  return `${reps}${w}${s.rpe ? ` · RPE ${s.rpe}` : ''}`;
}

function parseNum(v: string): number | null {
  const n = Number(v.replace(',', '.'));
  return v.trim() && Number.isFinite(n) ? n : null;
}

function ExerciseCard({
  exerciseKey,
  view,
  sets,
  sessionId,
  onLogged,
}: {
  exerciseKey: string;
  view: ExerciseView | undefined;
  sets: SerializedSet[];
  sessionId: string;
  onLogged: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const ex = EXERCISE_BY_KEY[exerciseKey];
  const unit = view?.unit ?? (exerciseKey === 'plank' ? 'seconds' : 'reps');
  const prefill = view?.prefill ?? { reps: null, weightKg: null };
  const [reps, setReps] = useState(prefill.reps !== null ? String(prefill.reps) : '');
  const [weight, setWeight] = useState(prefill.weightKg !== null ? String(prefill.weightKg) : '');
  const [rpe, setRpe] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [showCues, setShowCues] = useState(false);
  const target = view?.target;

  // after a set is logged, prefill the next one with the same values (adjusting state on prop change)
  const last = sets.at(-1);
  const [seenLast, setSeenLast] = useState(last?.id);
  if (last && last.id !== seenLast) {
    setSeenLast(last.id);
    setReps(last.actualReps !== null ? String(last.actualReps) : '');
    setWeight(last.weightKg !== null ? String(last.weightKg) : '');
  }

  async function log(e: FormEvent) {
    e.preventDefault();
    const r = parseNum(reps);
    if (r === null || !Number.isInteger(r) || r < 0) return toast.error(unit === 'seconds' ? 'Секунды — целое число' : 'Повторы — целое число');
    const w = weight.trim() ? parseNum(weight) : null;
    if (weight.trim() && (w === null || w < 0)) return toast.error('Вес — число в кг');
    setBusy('log');
    try {
      await api(`/api/workouts/sessions/${sessionId}/sets`, {
        body: { exerciseKey, actualReps: r, weightKg: w, rpe: rpe ? Number(rpe) : null, targetReps: target?.repsMax ?? null },
      });
      setRpe('');
      router.refresh();
      onLogged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function remove(id: string) {
    setBusy(id);
    try {
      await api(`/api/workouts/sets/${id}`, { method: 'DELETE' });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  if (!ex) return null;
  return (
    <Card className="p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="font-semibold leading-snug">{ex.name}</h3>
          <p className="text-xs text-muted">
            {target ? `${target.sets} × ${target.repsMin}–${target.repsMax}${unit === 'seconds' ? ' с' : ''}` : 'своё упражнение'} · {ex.equipment}
          </p>
        </div>
        <span className="tabular shrink-0 text-sm text-muted">
          {sets.length}
          {target ? `/${target.sets}` : ''}
        </span>
      </div>

      <button type="button" onClick={() => setShowCues((v) => !v)} aria-expanded={showCues} className="mt-1 flex min-h-11 items-center gap-1 text-sm text-accent">
        Техника <ChevronDown className={`size-4 transition-transform ${showCues ? 'rotate-180' : ''}`} />
      </button>
      {showCues ? (
        <ul className="mb-2 list-disc space-y-0.5 pl-5 text-sm text-muted">
          {ex.cues.map((c) => (
            <li key={c}>{c}</li>
          ))}
          <li>При боли — остановись. Это подсказки, а не медицинский совет.</li>
        </ul>
      ) : null}

      {view?.previous ? (
        <p className="text-sm text-muted">
          В прошлый раз ({formatDateShortRu(view.previous.localDate)}): {view.previous.sets.map((s) => fmtSet(s, unit)).join(', ')}
        </p>
      ) : null}
      {view?.offer && view.offer.action !== 'keep' ? <Suggestion offer={view.offer} className="mt-2" /> : null}
      {view?.acceptedWeightKg ? <p className="mt-1 text-xs text-accent">Принято: пробуем {view.acceptedWeightKg} кг</p> : null}

      {sets.length ? (
        <ol className="mt-2 divide-y divide-border rounded-xl bg-surface-2">
          {sets.map((s, i) => (
            <li key={s.id} className="flex items-center justify-between gap-2 pl-3">
              <span className="tabular text-sm">
                {i + 1}. {fmtSet(s, unit)}
              </span>
              <button type="button" aria-label={`Удалить подход ${i + 1}`} disabled={busy === s.id} onClick={() => remove(s.id)} className="grid size-11 place-items-center rounded-xl text-muted hover:text-danger">
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ol>
      ) : null}

      <form onSubmit={log} className="mt-3 grid grid-cols-[1fr_1fr_auto] items-end gap-2">
        <Input label={unit === 'seconds' ? 'Секунды' : 'Повторы'} inputMode="numeric" value={reps} onChange={(e) => setReps(e.target.value)} />
        <Input label="Вес, кг" inputMode="decimal" placeholder="без веса" value={weight} onChange={(e) => setWeight(e.target.value)} />
        <Select label="RPE" aria-label="Сложность подхода, RPE (необязательно)" value={rpe} onChange={(e) => setRpe(e.target.value)} className="w-20">
          <option value="">—</option>
          {[6, 7, 8, 9, 10].map((v) => (
            <option key={v} value={v}>
              {v}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="soft" block loading={busy === 'log'} icon={<Plus className="size-4" />} className="col-span-3">
          Записать подход
        </Button>
      </form>
    </Card>
  );
}

function FinishSheet({ open, onClose, session, defaultMinutes }: { open: boolean; onClose: () => void; session: SerializedSession; defaultMinutes: number }) {
  const router = useRouter();
  const toast = useToast();
  const [duration, setDuration] = useState(String(defaultMinutes));
  const [effort, setEffort] = useState<number | null>(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function finish() {
    const d = Number(duration);
    if (!Number.isInteger(d) || d < 1 || d > 600) return setError('Длительность — минуты от 1 до 600');
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ warnings: string[] }>(`/api/workouts/sessions/${session.id}/finish`, { body: { durationMinutes: d, perceivedEffort: effort, notes: notes.trim() || null } });
      toast.ok(['Тренировка записана', ...r.warnings].join(' '));
      onClose();
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Завершить тренировку"
      description="Рекомендации по весу строятся по записанным подходам, а не по нажатию «Завершить»."
      footer={
        <Button variant="primary" block loading={busy} onClick={finish}>
          Завершить
        </Button>
      }
    >
      <div className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Input label="Длительность, мин" inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
        <div>
          <p className="mb-1.5 text-sm font-medium">Насколько тяжело было (1 — легко, 10 — предел)</p>
          <Chips ariaLabel="Субъективная сложность" options={Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: String(i + 1) }))} value={effort ? [effort] : []} onChange={(v) => setEffort(v[0] === effort ? null : (v[0] ?? null))} />
        </div>
        <Textarea label="Заметки" placeholder="самочувствие, что поменять в следующий раз — по желанию" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} />
      </div>
    </Sheet>
  );
}

function Elapsed({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 15000);
    return () => window.clearInterval(id);
  }, []);
  if (!since) return null;
  const min = Math.max(0, Math.round((now - new Date(since).getTime()) / 60000));
  return <span className="tabular">{min} мин</span>;
}

export function ActiveSession({ overview, routine }: { overview: WorkoutOverview; routine: Routine | null }) {
  const router = useRouter();
  const toast = useToast();
  const { tz } = useClientUser();
  const active = overview.active!;
  const timer = useRef<RestTimerHandle>(null);
  const [extra, setExtra] = useState<string[]>([]);
  const [finishing, setFinishing] = useState<number | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [busy, setBusy] = useState(false);
  const routineKeys = routine?.exercises.map((e) => e.exerciseKey) ?? [];
  const logged = [...new Set(active.sets.map((s) => s.exerciseKey))];
  const keys = [...new Set([...routineKeys, ...logged, ...extra])];
  const linked = overview.weekEvents.find((e) => e.id === active.scheduleEventId);

  async function cancel() {
    setBusy(true);
    try {
      await api(`/api/workouts/sessions/${active.id}/cancel`, { body: {} });
      toast.ok('Тренировка отменена — ничего не засчитано');
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
      setConfirmCancel(false);
    }
  }

  return (
    <div className="space-y-3">
      <Card className="p-4">
        <p className="text-xs font-medium uppercase tracking-wide text-accent">Идёт тренировка</p>
        <h2 className="mt-0.5 text-xl font-semibold">{routine?.name ?? 'Тренировка'}</h2>
        <p className="text-sm text-muted">
          Начата в {active.startedAt ? formatTime(active.startedAt, tz) : '—'} · <Elapsed since={active.startedAt} />
          {linked ? ` · по плану ${formatDateShortRu(linked.localDate)}` : ''}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            variant="primary"
            size="lg"
            className="flex-1"
            onClick={() => setFinishing(active.startedAt ? Math.min(600, Math.max(1, Math.round((Date.now() - new Date(active.startedAt).getTime()) / 60000))) : 60)}
          >
            Завершить
          </Button>
          {confirmCancel ? (
            <Button variant="danger" loading={busy} onClick={cancel}>
              Точно отменить
            </Button>
          ) : (
            <Button variant="ghost" onClick={() => setConfirmCancel(true)}>
              Отменить
            </Button>
          )}
        </div>
      </Card>

      <div className="sticky top-14 z-20 lg:top-4">
        <RestTimer ref={timer} />
      </div>

      {keys.map((k) => (
        <ExerciseCard key={k} exerciseKey={k} view={overview.exercises[k]} sets={active.sets.filter((s) => s.exerciseKey === k)} sessionId={active.id} onLogged={() => timer.current?.start()} />
      ))}

      <Card className="p-4">
        <Select
          label="Добавить упражнение"
          value=""
          onChange={(e) => {
            const v = e.target.value;
            if (v) setExtra((x) => [...x, v]);
          }}
        >
          <option value="">Выбери из каталога…</option>
          {EXERCISES.filter((e) => !keys.includes(e.key)).map((e) => (
            <option key={e.key} value={e.key}>
              {e.name}
            </option>
          ))}
        </Select>
      </Card>

      <FinishSheet key={finishing ?? 'closed'} open={finishing !== null} onClose={() => setFinishing(null)} session={active} defaultMinutes={finishing ?? 60} />
    </div>
  );
}
