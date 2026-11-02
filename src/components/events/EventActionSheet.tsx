'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CONSUMPTION_LABELS, KIND_LABELS, MEAL_KINDS, STATUS_LABELS, type ConsumptionStatus, type EventKind, type EventPriority, type EventStatus } from '@/domain/types';
import { formatDateRu, formatRange, isoWeekday, localDateOf, localTimeOf, relativeDayLabel, weekdayShort } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Chips, Input } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { openExtraWork } from '@/components/shell/events';
import { useClientUser } from '@/components/shell/UserContext';
import { PRIORITY_SHORT, SKIP_REASONS, statusTone } from './meta';

export interface UiEvent {
  id: string;
  kind: EventKind;
  title: string;
  status: EventStatus;
  priorityClass: EventPriority;
  startAt: string;
  endAt: string;
  localDate: string;
  revision: number;
  reason: string | null;
  notes: string | null;
  flexWindow: { earliest: string; latest: string } | null;
  actualMinutes: number | null;
}

type Mode = 'menu' | 'skip' | 'reschedule' | 'meal';
type Phase = 'future' | 'current' | 'past';

export function EventActionSheet({ event, onClose, initialMode = 'menu' }: { event: UiEvent | null; onClose: () => void; initialMode?: Mode }) {
  if (!event) return null;
  return <EventActionSheetInner key={`${event.id}:${event.revision}:${initialMode}`} event={event} onClose={onClose} initialMode={initialMode} />;
}

function phaseOf(e: UiEvent, nowMs: number): Phase {
  if (Date.parse(e.endAt) < nowMs) return 'past';
  if (Date.parse(e.startAt) - 15 * 60_000 > nowMs) return 'future';
  return 'current';
}

function EventActionSheetInner({ event, onClose, initialMode }: { event: UiEvent; onClose: () => void; initialMode: Mode }) {
  const { tz, today } = useClientUser();
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const origDate = localDateOf(event.startAt, tz);
  const origTime = localTimeOf(event.startAt, tz);
  const [toDate, setToDate] = useState(origDate);
  const [toTime, setToTime] = useState(origTime);
  const [slots, setSlots] = useState<{ date: string; startTime: string }[] | null>(null);
  const [consumption, setConsumption] = useState<ConsumptionStatus>('all');
  const [description, setDescription] = useState('');
  const [actualMinutes, setActualMinutes] = useState('');
  const [phase] = useState<Phase>(() => phaseOf(event, Date.now()));

  const isMeal = MEAL_KINDS.includes(event.kind);
  const settled = ['completed', 'skipped', 'cancelled'].includes(event.status);
  const routine = event.kind === 'sleep' || event.kind === 'morning_routine';

  useEffect(() => {
    if (mode !== 'reschedule' || slots !== null) return;
    api<{ slots: { date: string; startTime: string }[] }>(`/api/plan/events/${event.id}/slots`)
      .then((r) => setSlots(r.slots))
      .catch(() => setSlots([]));
  }, [mode, slots, event.id]);

  async function transition(action: string, extra: Record<string, unknown> = {}) {
    setBusy(action);
    setError(null);
    try {
      const r = await api<{ message: string; warnings: string[] }>(`/api/plan/events/${event.id}/transition`, {
        body: { action, expectedRevision: event.revision, ...extra },
      });
      router.refresh();
      onClose();
      toast.ok([r.message, ...r.warnings].join(' '));
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function logMeal(status: ConsumptionStatus) {
    setBusy(`meal:${status}`);
    setError(null);
    try {
      const r = await api<{ log: { id: string } }>('/api/meals/log', { body: { eventId: event.id, consumptionStatus: status, description: description.trim() || null } });
      router.refresh();
      onClose();
      toast.ok(status === 'not_eaten' ? 'Отмечено: не ел' : `${KIND_LABELS[event.kind]} отмечен`, {
        label: 'Отменить',
        onClick: async () => {
          try {
            await api(`/api/meals/log/${r.log.id}`, { method: 'DELETE' });
            router.refresh();
          } catch (e) {
            toast.error(errorMessage(e));
          }
        },
      });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const minutesField = (
    <Input
      label="Сколько заняло, мин"
      hint="необязательно"
      inputMode="numeric"
      value={actualMinutes}
      onChange={(e) => setActualMinutes(e.target.value)}
      className="max-w-40"
    />
  );
  const complete = () => transition('complete', actualMinutes ? { actualMinutes: Number(actualMinutes) } : {});
  const changed = toDate !== origDate || toTime !== origTime;

  return (
    <Sheet
      open
      onClose={onClose}
      title={event.title}
      description={`${relativeDayLabel(origDate, today)}, ${formatRange(event.startAt, event.endAt, tz)} · ${KIND_LABELS[event.kind]}`}
    >
      <div className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Badge tone={statusTone(event.status)}>{STATUS_LABELS[event.status]}</Badge>
          <Badge>{PRIORITY_SHORT[event.priorityClass]}</Badge>
          {event.flexWindow ? <Badge>окно {event.flexWindow.earliest}–{event.flexWindow.latest}</Badge> : null}
        </div>
        {event.reason ? <p className="text-sm text-muted">Причина: {event.reason}</p> : null}
        {error ? <Notice tone="danger">{error}</Notice> : null}

        {mode === 'menu' ? (
          routine ? (
            <p className="text-sm text-muted">
              Это часть постоянного распорядка. Время меняется в{' '}
              <Link href="/onboarding" className="text-accent">
                настройках распорядка
              </Link>
              .
            </p>
          ) : settled ? (
            <Button variant="secondary" loading={busy === 'reopen'} onClick={() => transition('reopen')}>
              Снять отметку
            </Button>
          ) : event.kind === 'work' ? (
            phase === 'future' ? (
              <p className="text-sm text-muted">Основной рабочий блок. Если вечером понадобится больше времени — «Нужно поработать».</p>
            ) : (
              <div className="grid gap-2 sm:grid-cols-2">
                <Button variant="primary" loading={busy === 'complete'} onClick={() => transition('complete')}>
                  Закончил
                </Button>
                <Button
                  onClick={() => {
                    onClose();
                    openExtraWork();
                  }}
                >
                  Нужно поработать
                </Button>
              </div>
            )
          ) : isMeal ? (
            <div className="grid gap-2 sm:grid-cols-2">
              {phase !== 'future' ? (
                <>
                  <Button variant="primary" loading={busy === 'meal:all'} onClick={() => logMeal('all')}>
                    Поел
                  </Button>
                  <Button onClick={() => setMode('meal')}>Часть / заменил / не ел</Button>
                </>
              ) : null}
              {phase === 'current' && ['planned', 'notified', 'snoozed'].includes(event.status) ? (
                <Button loading={busy === 'snooze'} onClick={() => transition('snooze', { snoozeMinutes: 15 })}>
                  +15 минут
                </Button>
              ) : null}
              {phase !== 'past' ? <Button onClick={() => setMode('reschedule')}>Перенести</Button> : null}
              <Button variant="ghost" onClick={() => setMode('skip')}>
                {phase === 'past' ? 'Не было' : 'Не получится'}
              </Button>
            </div>
          ) : phase === 'future' ? (
            <div className="grid gap-2 sm:grid-cols-2">
              <Button variant="primary" onClick={() => setMode('reschedule')}>
                Перенести
              </Button>
              <Button variant="ghost" onClick={() => setMode('skip')}>
                Пропустить
              </Button>
            </div>
          ) : phase === 'current' ? (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                {event.status !== 'started' ? (
                  <Button variant="primary" loading={busy === 'start'} onClick={() => transition('start')}>
                    Начал
                  </Button>
                ) : null}
                <Button variant={event.status === 'started' ? 'primary' : 'secondary'} loading={busy === 'complete'} onClick={complete}>
                  Выполнил
                </Button>
                {['planned', 'notified', 'snoozed'].includes(event.status) ? (
                  <Button loading={busy === 'snooze'} onClick={() => transition('snooze', { snoozeMinutes: 15 })}>
                    +15 минут
                  </Button>
                ) : null}
                <Button onClick={() => setMode('reschedule')}>Перенести</Button>
                <Button variant="ghost" onClick={() => setMode('skip')}>
                  Пропустить
                </Button>
              </div>
              {minutesField}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Button variant="primary" loading={busy === 'complete'} onClick={complete}>
                  Выполнил
                </Button>
                <Button variant="ghost" onClick={() => setMode('skip')}>
                  Не было
                </Button>
                <Button onClick={() => setMode('reschedule')}>Перенести на другое время</Button>
              </div>
              {minutesField}
            </div>
          )
        ) : null}

        {mode === 'skip' ? (
          <div className="space-y-3">
            <p className="text-sm font-medium">Почему? Это поможет в обзоре недели — без оценок.</p>
            <Chips ariaLabel="Причина" options={SKIP_REASONS.map((r) => ({ value: r, label: r }))} value={reason ? [reason] : []} onChange={(v) => setReason(v[0] ?? '')} />
            <Input aria-label="Своя причина" placeholder="Своя причина (необязательно)" value={SKIP_REASONS.includes(reason) ? '' : reason} onChange={(e) => setReason(e.target.value)} />
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setMode('menu')}>
                Назад
              </Button>
              <Button variant="primary" className="flex-1" loading={busy === 'skip'} onClick={() => transition('skip', { reason: reason || null })}>
                Отметить
              </Button>
            </div>
            {isMeal && phase !== 'past' ? <p className="text-xs text-muted">Можно перенести еду на ближайшее окно — это лучше, чем пропустить.</p> : null}
          </div>
        ) : null}

        {mode === 'reschedule' ? (
          <div className="space-y-3">
            {slots === null ? (
              <p className="text-sm text-muted">Ищу свободное время…</p>
            ) : slots.length ? (
              <div className="space-y-1.5">
                <p className="text-sm font-medium">Свободно</p>
                <Chips
                  ariaLabel="Варианты"
                  options={slots.map((s) => ({
                    value: `${s.date} ${s.startTime}`,
                    label: `${s.date === today ? 'Сегодня' : weekdayShort(isoWeekday(s.date))} ${s.startTime}`,
                  }))}
                  value={[`${toDate} ${toTime}`]}
                  onChange={(v) => {
                    const [d, tm] = (v[0] ?? '').split(' ');
                    if (d && tm) {
                      setToDate(d);
                      setToTime(tm);
                    }
                  }}
                />
              </div>
            ) : (
              <p className="text-sm text-muted">Свободных окон рядом не нашлось — выбери время вручную.</p>
            )}
            <div className="flex flex-wrap gap-2">
              <Input type="date" label={`День · ${formatDateRu(toDate)}`} value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-auto" />
              <Input type="time" label="Время" value={toTime} onChange={(e) => setToTime(e.target.value)} className="w-auto" />
            </div>
            <Chips ariaLabel="Причина переноса" options={SKIP_REASONS.map((r) => ({ value: r, label: r }))} value={reason ? [reason] : []} onChange={(v) => setReason(v[0] ?? '')} />
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setMode('menu')}>
                Назад
              </Button>
              <Button variant="primary" className="flex-1" loading={busy === 'reschedule'} disabled={!toDate || !toTime || !changed} onClick={() => transition('reschedule', { toDate, toTime, reason: reason || null })}>
                Перенести
              </Button>
            </div>
          </div>
        ) : null}

        {mode === 'meal' ? (
          <div className="space-y-3">
            <Chips
              ariaLabel="Как поел"
              options={(Object.keys(CONSUMPTION_LABELS) as ConsumptionStatus[]).map((k) => ({ value: k, label: CONSUMPTION_LABELS[k] }))}
              value={[consumption]}
              onChange={(v) => setConsumption(v[0]!)}
            />
            <Input aria-label="Что ел" placeholder="Что ел (необязательно), например домашний суп" value={description} onChange={(e) => setDescription(e.target.value)} />
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setMode('menu')}>
                Назад
              </Button>
              <Button variant="primary" className="flex-1" loading={busy === `meal:${consumption}`} onClick={() => logMeal(consumption)}>
                Сохранить
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
