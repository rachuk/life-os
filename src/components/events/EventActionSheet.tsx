'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CONSUMPTION_LABELS, KIND_LABELS, MEAL_KINDS, STATUS_LABELS, type ConsumptionStatus, type EventKind, type EventStatus } from '@/domain/types';
import { formatDateRu, formatRange, localDateOf, localTimeOf } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Chips, Input } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';
import { PRIORITY_SHORT, SKIP_REASONS, statusTone } from './meta';
import type { EventPriority } from '@/domain/types';

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

export function EventActionSheet({ event, onClose, initialMode = 'menu' }: { event: UiEvent | null; onClose: () => void; initialMode?: Mode }) {
  if (!event) return null;
  return <EventActionSheetInner key={`${event.id}:${event.revision}:${initialMode}`} event={event} onClose={onClose} initialMode={initialMode} />;
}

function EventActionSheetInner({ event, onClose, initialMode }: { event: UiEvent; onClose: () => void; initialMode: Mode }) {
  const { tz } = useClientUser();
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [toDate, setToDate] = useState(() => localDateOf(event.startAt, tz));
  const [toTime, setToTime] = useState(() => localTimeOf(event.startAt, tz));
  const [consumption, setConsumption] = useState<ConsumptionStatus>('all');
  const [description, setDescription] = useState('');
  const [actualMinutes, setActualMinutes] = useState('');

  const isMeal = MEAL_KINDS.includes(event.kind);
  const settled = ['completed', 'skipped', 'cancelled'].includes(event.status);

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

  async function logMeal() {
    setBusy('meal');
    setError(null);
    try {
      await api('/api/meals/log', { body: { eventId: event.id, consumptionStatus: consumption, description: description.trim() || null } });
      router.refresh();
      onClose();
      toast.ok(consumption === 'not_eaten' ? 'Отмечено: не ел' : 'Приём пищи отмечен');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet
      open={!!event}
      onClose={onClose}
      title={event.title}
      description={`${formatDateRu(localDateOf(event.startAt, tz))}, ${formatRange(event.startAt, event.endAt, tz)} · ${KIND_LABELS[event.kind]}`}
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
          <div className="grid gap-2 sm:grid-cols-2">
            {isMeal && !settled ? (
              <Button variant="primary" onClick={() => setMode('meal')} className="sm:col-span-2">
                Отметить приём пищи
              </Button>
            ) : null}
            {!settled && event.status !== 'started' ? (
              <Button variant={isMeal ? 'secondary' : 'primary'} loading={busy === 'start'} onClick={() => transition('start')}>
                Начал
              </Button>
            ) : null}
            {!settled && !isMeal ? (
              <div className="flex gap-2 sm:col-span-2">
                <Input aria-label="Сколько заняло, мин" inputMode="numeric" placeholder="Мин (необяз.)" value={actualMinutes} onChange={(e) => setActualMinutes(e.target.value)} className="max-w-36" />
                <Button
                  variant={event.status === 'started' ? 'primary' : 'secondary'}
                  className="flex-1"
                  loading={busy === 'complete'}
                  onClick={() => transition('complete', actualMinutes ? { actualMinutes: Number(actualMinutes) } : {})}
                >
                  Выполнил
                </Button>
              </div>
            ) : null}
            {!settled && ['planned', 'notified', 'snoozed'].includes(event.status) ? (
              <Button loading={busy === 'snooze'} onClick={() => transition('snooze', { snoozeMinutes: 15 })}>
                +15 минут
              </Button>
            ) : null}
            {event.kind !== 'sleep' && event.kind !== 'work' ? (
              <Button onClick={() => setMode('reschedule')}>Перенести</Button>
            ) : null}
            {!settled ? (
              <Button variant="ghost" onClick={() => setMode('skip')}>
                {isMeal ? 'Не могу / пропускаю' : 'Пропустить'}
              </Button>
            ) : (
              <Button variant="ghost" loading={busy === 'reopen'} onClick={() => transition('reopen')}>
                Снять отметку
              </Button>
            )}
          </div>
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
                Отметить пропуск
              </Button>
            </div>
            {isMeal ? <p className="text-xs text-muted">Можно перенести еду на ближайшее окно — это лучше, чем пропустить.</p> : null}
          </div>
        ) : null}

        {mode === 'reschedule' ? (
          <div className="space-y-3">
            <div className="flex flex-wrap gap-2">
              <Input type="date" label="День" value={toDate} onChange={(e) => setToDate(e.target.value)} className="w-auto" />
              <Input type="time" label="Время" value={toTime} onChange={(e) => setToTime(e.target.value)} className="w-auto" />
            </div>
            <Chips ariaLabel="Причина переноса" options={SKIP_REASONS.map((r) => ({ value: r, label: r }))} value={reason ? [reason] : []} onChange={(v) => setReason(v[0] ?? '')} />
            <div className="flex gap-2">
              <Button variant="ghost" onClick={() => setMode('menu')}>
                Назад
              </Button>
              <Button variant="primary" className="flex-1" loading={busy === 'reschedule'} disabled={!toDate || !toTime} onClick={() => transition('reschedule', { toDate, toTime, reason: reason || null })}>
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
              <Button variant="primary" className="flex-1" loading={busy === 'meal'} onClick={logMeal}>
                Сохранить
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
