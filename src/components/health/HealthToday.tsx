'use client';
import { Droplet, Footprints, Moon, Scale, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { MetricType } from '@/domain/types';
import { SLEEP_QUALITY_LABELS, hoursToMinutes, minutesToHoursLabel } from '@/domain/health/series';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Chips, Input } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useMeasurements, type MeasurementPayload } from './useMeasurements';

export interface TodayHealth {
  date: string;
  summary: { weight: number | null; steps: number | null; waterMl: number | null; sleepMinutes: number | null; sleepQuality: number | null; energy: number | null };
  measurements: { id: string; metricType: MetricType; value: number; measuredAt: string }[];
}

const nf = new Intl.NumberFormat('ru-RU');
const METRIC_DONE: Partial<Record<MetricType, string>> = {
  weight: 'Вес сохранён',
  steps: 'Шаги сохранены',
  sleep_minutes: 'Сон сохранён',
  sleep_quality: 'Качество сна сохранено',
  energy: 'Энергия сохранена',
};

function Tile({ id, icon, title, value, empty, children }: { id?: string; icon: ReactNode; title: string; value: string | null; empty?: string; children: ReactNode }) {
  return (
    <Card id={id} className="scroll-mt-20 p-4">
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
        {icon}
        {title}
      </div>
      <div className={value === null ? 'mt-1 text-lg text-faint' : 'mt-1 text-2xl font-semibold'}>{value ?? empty ?? 'нет данных'}</div>
      <div className="mt-3">{children}</div>
    </Card>
  );
}

function parseNum(raw: string): number | null {
  const v = Number(raw.replace(',', '.').replace(/\s/g, ''));
  return raw.trim() && Number.isFinite(v) ? v : null;
}

export function HealthToday({ data }: { data: TodayHealth }) {
  const router = useRouter();
  const toast = useToast();
  const m = useMeasurements();
  const [busy, setBusy] = useState<string | null>(null);
  const [weight, setWeight] = useState('');
  const [steps, setSteps] = useState('');
  const [sleepH, setSleepH] = useState('');
  const [quality, setQuality] = useState<number | null>(null);
  const [energy, setEnergy] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const s = data.summary;
  const water = data.measurements.filter((x) => x.metricType === 'water_ml');

  async function submit(key: string, payloads: MeasurementPayload[], after?: () => void) {
    setBusy(key);
    setError(null);
    try {
      const r = await m.save(payloads);
      if (r.saved.length) {
        toast.ok(payloads.length === 1 ? (METRIC_DONE[payloads[0]!.metricType] ?? 'Сохранено') : 'Сохранено');
        router.refresh();
      }
      if (!r.duplicates.length) after?.();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function confirmReplace() {
    setBusy('replace');
    try {
      await m.replaceAll();
      toast.ok('Значение заменено');
      setWeight('');
      setSteps('');
      router.refresh();
    } catch (e) {
      setError(errorMessage(e));
      m.dismiss();
    } finally {
      setBusy(null);
    }
  }

  async function addWater(ml: number) {
    setBusy(`water${ml}`);
    try {
      const r = await api<{ measurement: { id: string } }>('/api/health/measurements', { body: { metricType: 'water_ml', value: ml, sourceType: 'manual' } });
      router.refresh();
      toast.ok(`+${ml} мл`, { label: 'Отменить', onClick: () => void removeMeasurement(r.measurement.id) });
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function removeMeasurement(id: string) {
    try {
      await api(`/api/health/measurements/${id}`, { method: 'DELETE' });
      router.refresh();
      toast.info('Отметка удалена');
    } catch (e) {
      toast.error(errorMessage(e));
    }
  }

  function onWeight(e: FormEvent) {
    e.preventDefault();
    const v = parseNum(weight);
    if (v === null) return setError('Вес: введи число, например 53.2');
    void submit('weight', [{ metricType: 'weight', value: Math.round(v * 10) / 10 }], () => setWeight(''));
  }
  function onSteps(e: FormEvent) {
    e.preventDefault();
    const v = parseNum(steps);
    if (v === null || !Number.isInteger(v)) return setError('Шаги: целое число за один день');
    void submit('steps', [{ metricType: 'steps', value: v }], () => setSteps(''));
  }
  function onCheckin(e: FormEvent) {
    e.preventDefault();
    const payloads: MeasurementPayload[] = [];
    const h = parseNum(sleepH);
    if (sleepH.trim()) {
      if (h === null || h < 0 || h > 24) return setError('Сон: часы от 0 до 24, например 7.5');
      payloads.push({ metricType: 'sleep_minutes', value: hoursToMinutes(h) });
    }
    if (quality) payloads.push({ metricType: 'sleep_quality', value: quality });
    if (energy) payloads.push({ metricType: 'energy', value: energy });
    if (!payloads.length) return setError('Заполни хотя бы одно поле — или пропусти, это необязательно');
    void submit('checkin', payloads, () => {
      setSleepH('');
      setQuality(null);
      setEnergy(null);
    });
  }

  return (
    <div className="space-y-3">
      {error ? (
        <Notice tone="danger" className="flex items-start justify-between gap-2">
          <span>{error}</span>
          <button type="button" className="text-xs underline" onClick={() => setError(null)}>
            скрыть
          </button>
        </Notice>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Tile id="weight" icon={<Scale className="size-3.5" />} title="Вес сегодня" value={s.weight !== null ? `${nf.format(s.weight)} кг` : null}>
          <form onSubmit={onWeight} className="flex gap-2">
            <Input aria-label="Вес, кг" inputMode="decimal" placeholder="кг, например 53.2" value={weight} onChange={(e) => setWeight(e.target.value)} className="min-w-0 flex-1" />
            <Button type="submit" variant="soft" loading={busy === 'weight'} disabled={!weight.trim()}>
              {s.weight !== null ? 'Изменить' : 'Сохранить'}
            </Button>
          </form>
          <p className="mt-1.5 text-xs text-muted">Лучше утром в похожих условиях, но не обязательно.</p>
        </Tile>

        <Tile id="steps" icon={<Footprints className="size-3.5" />} title="Шаги сегодня" value={s.steps !== null ? nf.format(s.steps) : null}>
          <form onSubmit={onSteps} className="flex gap-2">
            <Input aria-label="Шаги за день" inputMode="numeric" placeholder="число за день" value={steps} onChange={(e) => setSteps(e.target.value)} className="min-w-0 flex-1" />
            <Button type="submit" variant="soft" loading={busy === 'steps'} disabled={!steps.trim()}>
              {s.steps !== null ? 'Изменить' : 'Сохранить'}
            </Button>
          </form>
          <p className="mt-1.5 text-xs text-muted">Только за один день — недельная сумма из Apple Health сюда не подходит.</p>
        </Tile>

        <Tile icon={<Droplet className="size-3.5" />} title="Вода сегодня" value={s.waterMl !== null ? `${nf.format(s.waterMl)} мл` : null}>
          <div className="flex flex-wrap gap-2">
            <Button variant="soft" loading={busy === 'water250'} onClick={() => addWater(250)}>
              +250 мл
            </Button>
            <Button variant="soft" loading={busy === 'water500'} onClick={() => addWater(500)}>
              +500 мл
            </Button>
            {water.length ? (
              <Button variant="ghost" icon={<Undo2 className="size-4" />} onClick={() => removeMeasurement(water.at(-1)!.id)}>
                Убрать последнее
              </Button>
            ) : null}
          </div>
          <p className="mt-1.5 text-xs text-muted">Пей с едой и по жажде. Без отметок — «нет данных», а не «не пил». Нормы не навязываем.</p>
        </Tile>

        <Tile
          icon={<Moon className="size-3.5" />}
          title="Утренний самочек"
          value={
            s.sleepMinutes !== null || s.sleepQuality !== null || s.energy !== null
              ? [
                  s.sleepMinutes !== null ? minutesToHoursLabel(s.sleepMinutes) : null,
                  s.sleepQuality !== null ? `сон ${SLEEP_QUALITY_LABELS[s.sleepQuality] ?? ''}` : null,
                  s.energy !== null ? `энергия ${s.energy}/5` : null,
                ]
                  .filter(Boolean)
                  .join(' · ')
              : null
          }
          empty="по желанию"
        >
          <form onSubmit={onCheckin} className="space-y-2.5">
            <Input aria-label="Сколько спал, часов" inputMode="decimal" placeholder="Сон, часов (например 7.5)" value={sleepH} onChange={(e) => setSleepH(e.target.value)} />
            <Chips
              ariaLabel="Как спал"
              options={[1, 2, 3].map((v) => ({ value: v, label: SLEEP_QUALITY_LABELS[v]! }))}
              value={quality ? [quality] : []}
              onChange={(v) => setQuality(v[0] === quality ? null : (v[0] ?? null))}
            />
            <div>
              <p className="mb-1 text-xs text-muted">Энергия</p>
              <Chips ariaLabel="Энергия от 1 до 5" options={[1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) }))} value={energy ? [energy] : []} onChange={(v) => setEnergy(v[0] === energy ? null : (v[0] ?? null))} />
            </div>
            <Button type="submit" variant="soft" block loading={busy === 'checkin'}>
              Сохранить самочек
            </Button>
          </form>
        </Tile>
      </div>

      <Sheet
        open={m.pending.length > 0}
        onClose={m.dismiss}
        title="Заменить?"
        description="За этот день уже есть значение. Дубли не добавляем — можно заменить осознанно."
        footer={
          <div className="flex gap-2">
            <Button variant="ghost" onClick={m.dismiss}>
              Оставить как было
            </Button>
            <Button variant="primary" className="flex-1" loading={busy === 'replace'} onClick={confirmReplace}>
              Заменить
            </Button>
          </div>
        }
      >
        <ul className="space-y-2 text-sm">
          {m.pending.map((d) => (
            <li key={d.payload.metricType} className="rounded-xl bg-surface-2 px-3 py-2">
              <span className="text-muted">Было:</span>{' '}
              <span className="tabular font-medium">
                {d.payload.metricType === 'sleep_minutes' ? minutesToHoursLabel(d.existing.value) : `${nf.format(d.existing.value)} ${d.existing.unit}`}
              </span>{' '}
              → <span className="text-muted">станет:</span>{' '}
              <span className="tabular font-medium">
                {d.payload.metricType === 'sleep_minutes' ? minutesToHoursLabel(d.payload.value) : `${nf.format(d.payload.value)} ${d.existing.unit}`}
              </span>
            </li>
          ))}
        </ul>
      </Sheet>
    </div>
  );
}
