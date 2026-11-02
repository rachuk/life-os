'use client';
import { ArrowRight, Ban, Moon, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ExtraWorkPreview } from '@/domain/planner/extraWork';
import { addDays, formatDateRu, formatDuration, formatRange, formatTime, isoWeekday, relativeDayLabel, timeToMinutes } from '@/domain/time';
import { api, ApiError, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Chips, Input } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice, Skeleton } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';

type Preview = ExtraWorkPreview & { basePlanVersion: number; newPlanVersion: number; fingerprint: string };

const DURATIONS = [30, 60, 120, 180, 240];

export function ExtraWorkSheet({ open, onClose, initialMinutes }: { open: boolean; onClose: () => void; initialMinutes?: number }) {
  const user = useClientUser();
  const router = useRouter();
  const toast = useToast();
  const [date, setDate] = useState(user.today);
  const [minutes, setMinutes] = useState(initialMinutes ?? 120);
  const [custom, setCustom] = useState('');
  const [startMode, setStartMode] = useState<'after_work' | 'now' | 'at'>(() => {
    const t = timeToMinutes(new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: user.tz }).format(new Date()));
    return t >= timeToMinutes(user.workEnd) || !user.workDays.includes(isoWeekday(user.today)) ? 'now' : 'after_work';
  });
  const [startTime, setStartTime] = useState('19:00');
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [committing, setCommitting] = useState(false);
  const [conflictNote, setConflictNote] = useState<string | null>(null);
  const reqId = useRef(0);

  const isWorkDay = user.workDays.includes(isoWeekday(date || user.today));
  const [nowLocal] = useState(() => new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: user.tz }).format(new Date()));
  const afterWorkPassed = date === user.today && timeToMinutes(nowLocal) >= timeToMinutes(user.workEnd);

  const body = useMemo(
    () => ({ date, startMode, startTime: startMode === 'at' ? startTime : null, durationMinutes: minutes, reason: reason.trim() || null }),
    [date, startMode, startTime, minutes, reason],
  );

  const load = useCallback(async () => {
    const id = ++reqId.current;
    setLoading(true);
    setError(null);
    try {
      const p = await api<Preview>('/api/plan/extra-work/preview', { body });
      if (id === reqId.current) {
        setPreview(p);
        setAck(false);
      }
    } catch (e) {
      if (id === reqId.current) setError(errorMessage(e));
    } finally {
      if (id === reqId.current) setLoading(false);
    }
  }, [body]);

  useEffect(() => {
    if (!open) return;
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [open, load]);

  async function commit() {
    if (!preview) return;
    setCommitting(true);
    setConflictNote(null);
    try {
      const res = await api<{ versionId: string }>('/api/plan/extra-work/commit', {
        body: { ...body, expectedPlanVersion: preview.basePlanVersion, acknowledgeRisks: ack, fingerprint: preview.fingerprint },
      });
      onClose();
      router.refresh();
      toast.ok(`План перестроен: +${formatDuration(preview.plannedMinutes)} работы`, {
        label: 'Отменить',
        onClick: async () => {
          try {
            await api(`/api/plan/versions/${res.versionId}/undo`, { method: 'POST', body: {} });
            router.refresh();
            toast.ok('Переработка отменена, план и напоминания восстановлены');
          } catch (e) {
            toast.error(errorMessage(e));
          }
        },
      });
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && (e.details as { preview?: Preview })?.preview) {
        setPreview((e.details as { preview: Preview }).preview);
        setConflictNote(e.message);
      } else if (e instanceof ApiError && (e.details as { preview?: Preview })?.preview) {
        setPreview((e.details as { preview: Preview }).preview);
        setError(e.message);
      } else setError(errorMessage(e));
    } finally {
      setCommitting(false);
    }
  }

  const days = [user.today, addDays(user.today, 1)];
  const tz = user.tz;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Нужно поработать"
      description="Сначала покажу, что изменится. Сон и еда автоматически не сокращаются."
      size="lg"
      footer={
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button variant="ghost" onClick={onClose}>
            Отменить
          </Button>
          <Button
            variant="primary"
            size="lg"
            loading={committing}
            disabled={!preview?.canCommit || loading || (preview.requiresRiskAcknowledgement && !ack)}
            onClick={commit}
          >
            Подтвердить{preview?.plannedMinutes ? ` +${formatDuration(preview.plannedMinutes)}` : ''}
          </Button>
        </div>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <p className="text-sm font-medium">Сколько</p>
          <Chips
            ariaLabel="Длительность"
            options={DURATIONS.map((d) => ({ value: d, label: d < 60 ? `+${d} мин` : `+${d / 60} ч` }))}
            value={[minutes]}
            onChange={(v) => {
              setMinutes(v[0]!);
              setCustom('');
            }}
          />
          <div className="flex items-center gap-2">
            <Input
              aria-label="Своя длительность в минутах"
              inputMode="numeric"
              placeholder="Своё, мин"
              value={custom}
              onChange={(e) => {
                setCustom(e.target.value);
                const n = Number(e.target.value);
                if (Number.isInteger(n) && n >= 15 && n <= 480) setMinutes(n);
              }}
              className="max-w-40"
            />
            <span className="text-sm text-muted">от 15 до 480</span>
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <p className="text-sm font-medium">День</p>
            <Chips ariaLabel="День" options={days.map((d) => ({ value: d, label: relativeDayLabel(d, user.today) }))} value={[date]} onChange={(v) => setDate(v[0]!)} />
          </div>
          <div className="space-y-2">
            <p className="text-sm font-medium">Начало</p>
            <Chips
              ariaLabel="Начало"
              options={[
                ...(isWorkDay ? [{ value: 'after_work' as const, label: afterWorkPassed ? `С ${user.workEnd} (прошло)` : `После работы, ${user.workEnd}` }] : []),
                ...(date === user.today ? [{ value: 'now' as const, label: `Сейчас, ${nowLocal}` }] : []),
                { value: 'at' as const, label: 'Указать время' },
              ]}
              value={[startMode]}
              onChange={(v) => setStartMode(v[0]!)}
            />
            {startMode === 'at' ? <Input type="time" aria-label="Время начала" value={startTime} onChange={(e) => setStartTime(e.target.value)} className="max-w-36" /> : null}
          </div>
        </div>

        <Input
          label="Причина (необязательно)"
          hint="Нейтрально, без названий клиентов и рабочих деталей"
          placeholder="например, важная задача"
          maxLength={120}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />

        <div aria-live="polite" className="space-y-3">
          <h3 className="text-sm font-semibold">Предпросмотр{date !== user.today ? ` · ${formatDateRu(date)}` : ''}</h3>
          {conflictNote ? <Notice tone="warn">{conflictNote}</Notice> : null}
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {loading && !preview ? <Skeleton className="h-28" /> : null}
          {preview ? (
            <div className={loading ? 'opacity-60 transition-opacity' : ''}>
              {preview.segments.length ? (
                <div className="rounded-2xl border border-border p-3">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted">Дополнительная работа</p>
                  <ul className="mt-1 space-y-0.5">
                    {preview.segments.map((s) => (
                      <li key={s.startAt} className="tabular text-[15px] font-semibold" style={{ color: 'var(--c-extra)' }}>
                        {formatRange(s.startAt, s.endAt, tz)}
                      </li>
                    ))}
                  </ul>
                  {preview.plannedMinutes !== preview.requestedMinutes ? (
                    <p className="mt-1 text-sm text-muted">
                      Поместится {formatDuration(preview.plannedMinutes)} из {formatDuration(preview.requestedMinutes)}
                    </p>
                  ) : null}
                </div>
              ) : null}

              {preview.notes.map((n) => (
                <p key={n} className="mt-2 text-sm text-muted">
                  {n}
                </p>
              ))}

              {preview.changes.length ? (
                <ul className="mt-3 space-y-2">
                  {preview.changes.map((c) => (
                    <li key={c.eventId} className="rounded-xl bg-surface-2 px-3 py-2.5">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[15px]">
                        {c.action === 'move' ? <ArrowRight className="size-4 text-accent" /> : <Ban className="size-4 text-danger" />}
                        <span className="font-medium">{c.title}</span>
                        <span className="tabular text-muted line-through decoration-faint">{formatTime(c.from.startAt, tz)}</span>
                        {c.to ? (
                          <span className="tabular font-medium">
                            {c.to.localDate !== c.from.localDate ? `${formatDateRu(c.to.localDate)}, ` : ''}
                            {formatRange(c.to.startAt, c.to.endAt, tz)}
                          </span>
                        ) : (
                          <span className="text-danger">не состоится</span>
                        )}
                      </div>
                      <p className="mt-0.5 text-sm text-muted">{c.reason}</p>
                    </li>
                  ))}
                </ul>
              ) : preview.segments.length ? (
                <p className="mt-3 flex items-center gap-2 text-sm text-ok">
                  <ShieldCheck className="size-4" /> Другие дела не затронуты
                </p>
              ) : null}

              {preview.conflicts.map((c) => (
                <div key={c.code} className="mt-3 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-danger">
                  <p className="flex items-start gap-2">
                    <Moon className="mt-0.5 size-4 shrink-0" /> {c.message}
                  </p>
                  {c.suggestedDurationMinutes ? (
                    <Button size="sm" variant="secondary" className="mt-2" onClick={() => setMinutes(c.suggestedDurationMinutes!)}>
                      Сократить до {formatDuration(c.suggestedDurationMinutes)}
                    </Button>
                  ) : null}
                </div>
              ))}

              {preview.weeklyTargetRisks.length ? (
                <div className="mt-3 rounded-xl bg-warn-soft px-3 py-2.5 text-sm text-warn">
                  {preview.weeklyTargetRisks.map((r) => (
                    <p key={r.eventId} className="flex items-start gap-2">
                      <TriangleAlert className="mt-0.5 size-4 shrink-0" /> {r.message}
                    </p>
                  ))}
                  <label className="mt-2 flex min-h-11 items-center gap-2 font-medium">
                    <input type="checkbox" className="size-5 accent-[var(--accent)]" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                    Понимаю риск, всё равно применить
                  </label>
                </div>
              ) : null}

              {preview.warnings.map((w) => (
                <Notice key={w} tone="warn" className="mt-3">
                  {w}
                </Notice>
              ))}
              {preview.protectedEventsPreserved && preview.segments.length ? (
                <p className="mt-3 text-xs text-muted">Сон и приёмы пищи сохранены. Напоминания пересчитаются после подтверждения.</p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Sheet>
  );
}
