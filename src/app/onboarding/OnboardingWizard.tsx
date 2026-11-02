'use client';
import { useRouter } from 'next/navigation';
import { useMemo, useState } from 'react';
import { DateTime } from 'luxon';
import { buildTemplates, checkMorning, parseMealWindows, parseNotificationPrefs, parseWeeklyTargets, type RoutinePrefs } from '@/domain/planner/prefs';
import { materializeRange } from '@/domain/planner/materialize';
import { addDays, formatRange, isoWeekday, weekdayShort, weekStartOf } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chips, Input, Select, Switch } from '@/components/ui/Field';
import { Notice } from '@/components/ui/States';
import { KIND_COLOR } from '@/components/events/meta';

type Form = {
  displayName: string | null;
  timezone: string;
  workDays: number[];
  workStart: string;
  workEnd: string;
  morningPrepMinutes: number;
  wakeTime: string;
  weekendWakeTime: string | null;
  bedTime: string;
  fallAsleepMinutes: number;
  meals: Record<string, unknown> & {
    lunch?: { start: string; duration: number; earliest: string; latest: string };
    dinner?: { start: string; duration: number; earliest: string; latest: string };
    snacks?: { enabled: boolean; times: string[]; duration: number };
  };
  gymStart: string;
  gymEnd: string;
  gymTravelMinutes: number | null;
  gymDays: number[] | null;
  targets: Record<string, unknown> & { workouts?: number; projectMinutes?: number };
  notifications: Record<string, unknown> & { eveningReviewTime?: string | null; repeatMinutes?: number };
  overtimeWarnMinutes: number;
  quietHours: { start: string; end: string } | null;
  habits: Record<string, boolean>;
  privacy: Record<string, unknown>;
};

const STEPS = ['Работа', 'Утро и сон', 'Еда', 'Движение', 'Привычки', 'Распорядок'] as const;
const DAYS = [1, 2, 3, 4, 5, 6, 7].map((d) => ({ value: d, label: weekdayShort(d) }));
const ZONES = ['Europe/Lisbon', 'Europe/London', 'Europe/Madrid', 'Europe/Berlin', 'Europe/Kyiv', 'Europe/Warsaw', 'America/New_York', 'Asia/Dubai'];
const HABITS: [string, string, string?][] = [
  ['breakfast', 'Завтрак', 'отметка после еды'],
  ['lunch', 'Обед внутри рабочего дня', 'резерв времени и напоминание'],
  ['dinner', 'Ужин', 'часто готовит соседка — план просто держит время'],
  ['snacks', 'Перекусы в рабочие дни'],
  ['water', 'Вода', 'быстрые отметки, без нормы «2 литра»'],
  ['steps', 'Шаги', 'сначала узнаем твой обычный уровень'],
  ['noWorkInBed', 'Не работать в кровати', 'вопрос вечером, исключения можно'],
  ['sleep', 'Сон', 'ориентир отбоя и подъёма'],
  ['workouts', 'Силовые тренировки'],
  ['own_project', 'Время на свои проекты'],
];

function previewPrefs(f: Form): RoutinePrefs {
  return {
    timezone: f.timezone,
    workDays: f.workDays,
    workStart: f.workStart,
    workEnd: f.workEnd,
    morningPrepMinutes: f.morningPrepMinutes,
    wakeTime: f.wakeTime,
    weekendWakeTime: f.weekendWakeTime,
    bedTime: f.bedTime,
    fallAsleepMinutes: f.fallAsleepMinutes,
    meals: parseMealWindows(f.meals),
    gymStart: f.gymStart,
    gymEnd: f.gymEnd,
    gymTravelMinutes: f.gymTravelMinutes,
    gymDays: f.gymDays?.length ? f.gymDays : null,
    targets: parseWeeklyTargets(f.targets),
    notifications: parseNotificationPrefs(f.notifications),
    overtimeWarnMinutes: f.overtimeWarnMinutes,
  };
}

export function OnboardingWizard({ initial, editing }: { initial: Form; editing: boolean }) {
  const router = useRouter();
  const [f, setF] = useState<Form>(initial);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));

  const prefs = useMemo(() => {
    try {
      return previewPrefs(f);
    } catch {
      return null;
    }
  }, [f]);
  const morning = prefs ? checkMorning(prefs) : null;
  const meals = prefs?.meals;
  const targets = prefs?.targets;

  const sample = useMemo(() => {
    if (!prefs) return null;
    try {
      const enabled = new Set(Object.entries(f.habits).filter(([, v]) => v).map(([k]) => k));
      const templates = buildTemplates(prefs, { enabledKeys: enabled }).map((t, i) => ({ ...t, id: `p${i}` }));
      const nowDt = DateTime.now().setZone(prefs.timezone);
      const ws = addDays(weekStartOf(nowDt.toISODate()!), 7);
      const res = materializeRange({ templates, tz: prefs.timezone, fromDate: ws, toDate: addDays(ws, 6), now: nowDt.toUTC(), existing: [], gymTravelMinutes: prefs.gymTravelMinutes });
      const workDay = addDays(ws, (prefs.workDays[1] ?? prefs.workDays[0] ?? 2) - 1);
      const weekend = addDays(ws, ([6, 7].find((d) => !prefs.workDays.includes(d)) ?? 6) - 1);
      const pick = (d: string) => res.events.filter((e) => e.localDate === d && e.kind !== 'sleep').sort((a, b) => a.startAt.toMillis() - b.startAt.toMillis());
      return { workDay, weekend, work: pick(workDay), off: pick(weekend), risks: res.risks };
    } catch {
      return null;
    }
  }, [prefs, f.habits]);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      await api('/api/onboarding', { body: f });
      router.replace('/today');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-5">
      <header>
        <p className="text-sm text-muted">
          {editing ? 'Настройки распорядка' : 'Первая настройка'} · шаг {step + 1} из {STEPS.length}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">{STEPS[step]}</h1>
        <div className="mt-3 flex gap-1" aria-hidden="true">
          {STEPS.map((s, i) => (
            <span key={s} className={`h-1 flex-1 rounded-full ${i <= step ? 'bg-accent' : 'bg-surface-3'}`} />
          ))}
        </div>
      </header>

      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Card className="space-y-5 p-5">
        {step === 0 ? (
          <>
            <Input label="Как к тебе обращаться (необязательно)" value={f.displayName ?? ''} onChange={(e) => set('displayName', e.target.value || null)} />
            <Select label="Часовой пояс" value={f.timezone} onChange={(e) => set('timezone', e.target.value)}>
              {[...new Set([f.timezone, ...ZONES])].map((z) => (
                <option key={z} value={z}>
                  {z}
                </option>
              ))}
            </Select>
            <div className="space-y-2">
              <p className="text-sm font-medium">Рабочие дни</p>
              <Chips ariaLabel="Рабочие дни" multiple options={DAYS} value={f.workDays} onChange={(v) => set('workDays', [...v].sort())} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input type="time" label="Начало работы" value={f.workStart} onChange={(e) => set('workStart', e.target.value)} />
              <Input type="time" label="Конец работы" value={f.workEnd} onChange={(e) => set('workEnd', e.target.value)} />
            </div>
            <p className="text-sm text-muted">Рабочий блок будет занят целиком, кроме перерывов на еду. Рабочий календарь подключать не нужно.</p>
          </>
        ) : null}

        {step === 1 ? (
          <>
            <div className="space-y-2">
              <p className="text-sm font-medium">Сколько тебе реально нужно утром до работы (гигиена, завтрак)?</p>
              <Chips ariaLabel="Утренняя подготовка" options={[30, 45, 60, 75, 90].map((m) => ({ value: m, label: `${m} мин` }))} value={[f.morningPrepMinutes]} onChange={(v) => set('morningPrepMinutes', v[0]!)} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input type="time" label="Желаемый подъём" value={f.wakeTime} onChange={(e) => set('wakeTime', e.target.value)} />
              <Input type="time" label="Подъём в выходные" hint="пусто — как в будни" value={f.weekendWakeTime ?? ''} onChange={(e) => set('weekendWakeTime', e.target.value || null)} />
              <Input type="time" label="Ориентир отбоя" value={f.bedTime} onChange={(e) => set('bedTime', e.target.value)} />
              <Input type="number" label="Засыпаешь примерно за, мин" min={0} max={120} value={f.fallAsleepMinutes} onChange={(e) => set('fallAsleepMinutes', Number(e.target.value) || 0)} />
            </div>
            {morning && !morning.ok ? <Notice tone="warn">{morning.message}</Notice> : morning ? <Notice tone="ok">В будни подъём не позже {morning.latestWake} — ты успеваешь.</Notice> : null}
            <p className="text-xs text-muted">Для пробуждения используй обычный будильник iPhone — веб-уведомления его не заменяют. Сон приложение никогда не сокращает ради работы.</p>
          </>
        ) : null}

        {step === 2 && meals ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Input type="time" label="Обед в рабочие дни" value={meals.lunch.start} onChange={(e) => set('meals', { ...f.meals, lunch: { ...meals.lunch, start: e.target.value } })} />
              <Input type="number" label="Длительность, мин" value={meals.lunch.duration} onChange={(e) => set('meals', { ...f.meals, lunch: { ...meals.lunch, duration: Number(e.target.value) || 30 } })} />
              <Input type="time" label="Обед можно сдвинуть с" value={meals.lunch.earliest} onChange={(e) => set('meals', { ...f.meals, lunch: { ...meals.lunch, earliest: e.target.value } })} />
              <Input type="time" label="…и до" value={meals.lunch.latest} onChange={(e) => set('meals', { ...f.meals, lunch: { ...meals.lunch, latest: e.target.value } })} />
              <Input type="time" label="Ужин" value={meals.dinner.start} onChange={(e) => set('meals', { ...f.meals, dinner: { ...meals.dinner, start: e.target.value } })} />
              <Input type="number" label="Длительность, мин" value={meals.dinner.duration} onChange={(e) => set('meals', { ...f.meals, dinner: { ...meals.dinner, duration: Number(e.target.value) || 30 } })} />
              <Input type="time" label="Ужин можно сдвинуть с" value={meals.dinner.earliest} onChange={(e) => set('meals', { ...f.meals, dinner: { ...meals.dinner, earliest: e.target.value } })} />
              <Input type="time" label="…и до" value={meals.dinner.latest} onChange={(e) => set('meals', { ...f.meals, dinner: { ...meals.dinner, latest: e.target.value } })} />
            </div>
            <Switch
              label="Перекусы в рабочие дни"
              description={meals.snacks.enabled ? `в ${meals.snacks.times.join(' и ')}` : 'выключены'}
              checked={meals.snacks.enabled}
              onChange={(v) => set('meals', { ...f.meals, snacks: { ...meals.snacks, enabled: v } })}
            />
            <p className="text-sm text-muted">Еда при переработке двигается только внутри этих окон. Калории не считаем — это не медицинский план.</p>
          </>
        ) : null}

        {step === 3 && targets ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Input type="time" label="Тренировка с" value={f.gymStart} onChange={(e) => set('gymStart', e.target.value)} />
              <Input type="time" label="до" value={f.gymEnd} onChange={(e) => set('gymEnd', e.target.value)} />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Сколько раз в неделю</p>
              <Chips ariaLabel="Тренировок в неделю" options={[0, 1, 2, 3, 4].map((n) => ({ value: n, label: n === 0 ? 'пока нет' : String(n) }))} value={[targets.workouts]} onChange={(v) => set('targets', { ...f.targets, workouts: v[0]! })} />
            </div>
            <div className="space-y-2">
              <p className="text-sm font-medium">Предпочтительные дни</p>
              <Chips ariaLabel="Дни тренировок" multiple options={DAYS} value={f.gymDays ?? []} onChange={(v) => set('gymDays', v.length ? [...v].sort() : null)} />
              <p className="text-xs text-muted">Если не выбрать — план подберёт дни сам. Перенос внутри недели не теряет цель.</p>
            </div>
            <Input
              type="number"
              label="Дорога до зала в одну сторону, мин"
              hint="Оставь пустым, если не знаешь — не будем придумывать"
              min={0}
              max={180}
              value={f.gymTravelMinutes ?? ''}
              onChange={(e) => set('gymTravelMinutes', e.target.value === '' ? null : Number(e.target.value))}
            />
            <div className="space-y-2">
              <p className="text-sm font-medium">Свои проекты: часов в неделю</p>
              <Chips ariaLabel="Свои проекты" options={[0, 60, 120, 180, 240, 300].map((m) => ({ value: m, label: m === 0 ? 'нет' : `${m / 60} ч` }))} value={[targets.projectMinutes]} onChange={(v) => set('targets', { ...f.targets, projectMinutes: v[0]! })} />
            </div>
            <Input type="number" label="Предупреждать, если переработки за неделю больше, ч" value={Math.round(f.overtimeWarnMinutes / 60)} onChange={(e) => set('overtimeWarnMinutes', (Number(e.target.value) || 0) * 60)} />
          </>
        ) : null}

        {step === 4 ? (
          <>
            <p className="text-sm text-muted">Пробный набор на неделю. Любое правило можно выключить сейчас или позже.</p>
            <div className="divide-y divide-border">
              {HABITS.map(([k, label, hint]) => (
                <Switch key={k} label={label} description={hint} checked={f.habits[k] ?? true} onChange={(v) => set('habits', { ...f.habits, [k]: v })} />
              ))}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Input
                type="time"
                label="Вечернее завершение дня"
                hint="пусто — за 45 мин до отбоя"
                value={(f.notifications.eveningReviewTime as string | null) ?? ''}
                onChange={(e) => set('notifications', { ...f.notifications, eveningReviewTime: e.target.value || null })}
              />
              <Input type="number" label="Повтор важного напоминания, мин" min={5} max={60} value={(f.notifications.repeatMinutes as number | undefined) ?? 15} onChange={(e) => set('notifications', { ...f.notifications, repeatMinutes: Number(e.target.value) || 15 })} />
            </div>
            <Switch label="Часы тишины" description={f.quietHours ? `${f.quietHours.start}–${f.quietHours.end}` : 'выключены'} checked={!!f.quietHours} onChange={(v) => set('quietHours', v ? { start: '00:30', end: '07:30' } : null)} />
            {f.quietHours ? (
              <div className="grid grid-cols-2 gap-3">
                <Input type="time" label="С" value={f.quietHours.start} onChange={(e) => set('quietHours', { ...f.quietHours!, start: e.target.value })} />
                <Input type="time" label="До" value={f.quietHours.end} onChange={(e) => set('quietHours', { ...f.quietHours!, end: e.target.value })} />
              </div>
            ) : null}
          </>
        ) : null}

        {step === 5 ? (
          <>
            <p className="text-sm text-muted">Вот твой базовый распорядок. Проверь часы — всё можно поменять позже в настройках.</p>
            {sample ? (
              <div className="grid gap-4 sm:grid-cols-2">
                {[
                  { title: `Будний день (${weekdayShort(isoWeekday(sample.workDay))})`, list: sample.work },
                  { title: `Выходной (${weekdayShort(isoWeekday(sample.weekend))})`, list: sample.off },
                ].map((col) => (
                  <div key={col.title}>
                    <p className="mb-2 text-sm font-semibold">{col.title}</p>
                    <ul className="space-y-1">
                      {col.list.map((e) => (
                        <li key={e.originKey} className="flex items-center gap-2 text-sm">
                          <span className="h-4 w-1 rounded-full" style={{ background: KIND_COLOR[e.kind] }} />
                          <span className="tabular w-24 shrink-0 text-muted">{formatRange(e.startAt, e.endAt, f.timezone)}</span>
                          <span className="truncate">{e.title}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            ) : (
              <Notice tone="warn">Проверь поля на предыдущих шагах — распорядок не строится.</Notice>
            )}
            {sample?.risks.length ? sample.risks.map((r) => <Notice key={r.message} tone="warn">{r.message}</Notice>) : null}
            <p className="text-xs text-muted">Время без блоков — свободное. План не заполняет день на 100%.</p>
          </>
        ) : null}
      </Card>

      <div className="flex items-center gap-2">
        {step > 0 ? (
          <Button variant="ghost" onClick={() => setStep(step - 1)}>
            Назад
          </Button>
        ) : null}
        <div className="ml-auto flex gap-2">
          {step < STEPS.length - 1 ? (
            <>
              {step >= 2 ? (
                <Button variant="ghost" onClick={() => setStep(STEPS.length - 1)}>
                  Пропустить
                </Button>
              ) : null}
              <Button variant="primary" onClick={() => setStep(step + 1)}>
                Дальше
              </Button>
            </>
          ) : (
            <Button variant="primary" size="lg" loading={busy} onClick={save}>
              {editing ? 'Сохранить и перестроить план' : 'Сохранить и построить план'}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
