'use client';
import { Check, Minus, Settings2, X } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDateRu, isoWeekday, weekdayShort } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Switch } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';

export interface HabitDef {
  id: string;
  key: string;
  name: string;
  type: string;
  enabled: boolean;
  target: number | null;
  unit: string | null;
  trackingMode: string;
}

export interface Checkin {
  habitId: string;
  localDate: string;
  status: string;
  reason: string | null;
}

type Status = 'done' | 'partial' | 'skipped' | 'exception';

const STATUS_TEXT: Record<Status, string> = { done: 'Да', partial: 'Частично', skipped: 'Не получилось', exception: 'Исключение' };

function Cell({ c, future }: { c: Checkin | undefined; future: boolean }) {
  if (future) return <span className="text-faint">·</span>;
  if (!c) return <span className="text-xs text-faint">?</span>;
  if (c.status === 'done') return <Check className="size-4 text-accent" aria-hidden="true" />;
  if (c.status === 'exception') return <span className="text-sm font-semibold text-warn">!</span>;
  if (c.status === 'partial') return <span className="text-xs font-semibold">½</span>;
  return <X className="size-4 text-muted" aria-hidden="true" />;
}

/**
 * Daily rules for the week (e.g. «Не работаю в кровати»): done, exception with reason, or not.
 * A day without an answer stays «?» — unknown, not a failure.
 */
export function HabitWeek({ habits, checkins, days, today }: { habits: HabitDef[]; checkins: Checkin[]; days: string[]; today: string }) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState<{ habit: HabitDef; date: string } | null>(null);
  const [reason, setReason] = useState('');
  const [mode, setMode] = useState<'choose' | 'exception'>('choose');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState(false);
  const rules = habits.filter((h) => h.type === 'daily_rule' && h.enabled);
  const byKey = new Map(checkins.map((c) => [`${c.habitId}:${c.localDate}`, c]));

  function openCell(habit: HabitDef, date: string) {
    const c = byKey.get(`${habit.id}:${date}`);
    setOpen({ habit, date });
    setMode(c?.status === 'exception' ? 'exception' : 'choose');
    setReason(c?.reason ?? '');
    setError(null);
  }

  async function answer(status: Status | null) {
    if (!open) return;
    setBusy(status ?? 'clear');
    setError(null);
    try {
      if (status === null) {
        await api(`/api/habits/checkins?habitId=${open.habit.id}&localDate=${open.date}`, { method: 'DELETE' });
      } else {
        await api('/api/habits/checkins', { body: { habitId: open.habit.id, localDate: open.date, status, reason: status === 'exception' ? reason.trim() || null : null } });
      }
      setOpen(null);
      router.refresh();
      toast.ok(status === null ? 'Отметка снята' : 'Отмечено');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const current = open ? byKey.get(`${open.habit.id}:${open.date}`) : undefined;

  return (
    <>
      <Card className="p-4">
        {rules.length ? (
          <div className="space-y-4">
            {rules.map((h) => (
              <div key={h.id}>
                <p className="mb-2 text-[15px] font-medium">{h.name}</p>
                <div className="grid grid-cols-7 gap-1.5">
                  {days.map((d) => {
                    const future = d > today;
                    const c = byKey.get(`${h.id}:${d}`);
                    return (
                      <button
                        key={d}
                        type="button"
                        disabled={future}
                        onClick={() => openCell(h, d)}
                        aria-label={`${formatDateRu(d)}: ${future ? 'ещё не наступил' : c ? STATUS_TEXT[c.status as Status] : 'нет ответа'}`}
                        className={cn(
                          'flex min-h-14 flex-col items-center justify-center gap-1 rounded-xl border text-xs transition-colors disabled:cursor-default',
                          d === today ? 'border-accent' : 'border-border',
                          c?.status === 'done' ? 'bg-accent-soft' : c?.status === 'exception' ? 'bg-warn-soft' : 'bg-surface hover:bg-surface-2',
                        )}
                      >
                        <span className="text-muted">{weekdayShort(isoWeekday(d))}</span>
                        <Cell c={c} future={future} />
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <Minus className="size-3" /> «?» — ответа нет, это не провал. Еда и тренировки отмечаются в событиях, вода, шаги и сон — выше.
            </p>
          </div>
        ) : (
          <EmptyState title="Ежедневные правила выключены">Их можно включить в настройке привычек.</EmptyState>
        )}
        <div className="mt-2 flex justify-end">
          <Button variant="ghost" size="sm" icon={<Settings2 className="size-4" />} onClick={() => setSettings(true)} className="min-h-11">
            Настроить привычки
          </Button>
        </div>
      </Card>

      <Sheet open={!!open} onClose={() => setOpen(null)} title={open?.habit.name ?? ''} description={open ? formatDateRu(open.date, { long: true }) : undefined}>
        <div className="space-y-3">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {mode === 'choose' ? (
            <div className="grid gap-2">
              <Button variant="primary" loading={busy === 'done'} onClick={() => answer('done')}>
                Да, соблюдал
              </Button>
              <Button onClick={() => setMode('exception')}>Было исключение…</Button>
              <Button variant="ghost" loading={busy === 'skipped'} onClick={() => answer('skipped')}>
                Не получилось
              </Button>
              {current ? (
                <Button variant="ghost" loading={busy === 'clear'} onClick={() => answer(null)}>
                  Снять отметку
                </Button>
              ) : null}
            </div>
          ) : (
            <div className="space-y-3">
              <Input label="Причина (необязательно)" placeholder="например, срочный созвон" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
              <div className="flex gap-2">
                <Button variant="ghost" onClick={() => setMode('choose')}>
                  Назад
                </Button>
                <Button variant="primary" className="flex-1" loading={busy === 'exception'} onClick={() => answer('exception')}>
                  Отметить исключение
                </Button>
              </div>
            </div>
          )}
        </div>
      </Sheet>

      <HabitSettings open={settings} onClose={() => setSettings(false)} habits={habits} />
    </>
  );
}

function HabitSettings({ open, onClose, habits }: { open: boolean; onClose: () => void; habits: HabitDef[] }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const steps = habits.find((h) => h.key === 'steps');
  const [stepsTarget, setStepsTarget] = useState(steps?.target ? String(steps.target) : '');

  async function patch(h: HabitDef, enabled: boolean, target?: number | null) {
    setBusy(h.id);
    try {
      await api('/api/habits', { method: 'PATCH', body: { habitId: h.id, enabled, target } });
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Привычки" description="Каждое правило можно выключить. Выключенное не напоминает и не попадает в обзор.">
      <div className="divide-y divide-border">
        {habits
          .filter((h) => h.type !== 'negative_boundary')
          .map((h) => (
            <Switch key={h.id} checked={h.enabled} disabled={busy === h.id} onChange={(v) => patch(h, v)} label={h.name} />
          ))}
      </div>
      {steps ? (
        <form
          className="mt-4 flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const v = Number(stepsTarget);
            if (!Number.isInteger(v) || v <= 0) return toast.error('Цель шагов — целое число');
            void patch(steps, steps.enabled, v).then(() => toast.ok('Цель сохранена'));
          }}
        >
          <Input label="Цель шагов в день" hint="Начни с привычного уровня и повышай постепенно" inputMode="numeric" value={stepsTarget} onChange={(e) => setStepsTarget(e.target.value)} />
          <Button type="submit" variant="soft" loading={busy === steps.id}>
            Сохранить
          </Button>
        </form>
      ) : null}
    </Sheet>
  );
}
