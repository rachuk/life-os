'use client';
import { Check, Droplet, Footprints, Info, Moon, Scale, Undo2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent, type ReactNode } from 'react';
import type { MetricType } from '@/domain/types';
import { SLEEP_QUALITY_LABELS, hoursToMinutes, minutesToHoursLabel } from '@/domain/health/series';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { Chips, Input } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';
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

/** One compact line of «Отметки сегодня»: what is known today on the left, the quick input on the right. */
function Row({ id, icon, label, value, children, below }: { id?: string; icon: ReactNode; label: string; value: string | null; children?: ReactNode; below?: ReactNode }) {
  return (
    <div id={id} className="scroll-mt-20 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-2">
        <div className="min-w-[5rem] flex-1">
          <p className="flex items-center gap-1.5 text-xs font-medium text-muted">
            {icon}
            {label}
          </p>
          <p className={cn('mt-0.5', value === null ? 'text-sm text-muted' : 'tabular text-[17px] font-semibold leading-snug')}>{value ?? 'нет данных'}</p>
        </div>
        {children ? <div className="flex shrink-0 items-center gap-1.5">{children}</div> : null}
      </div>
      {below}
    </div>
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
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [hints, setHints] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const s = data.summary;
  const water = data.measurements.filter((x) => x.metricType === 'water_ml');
  const hasCheckin = s.sleepMinutes !== null || s.sleepQuality !== null || s.energy !== null;

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
      setCheckinOpen(false);
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
      toast.ok(`Вода: +${nf.format(ml)} мл`, { label: 'Отменить', onClick: () => void removeMeasurement(r.measurement.id) });
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
    if (v === null) return setError('Вес: введи число, например 53,2');
    void submit('weight', [{ metricType: 'weight', value: Math.round(v * 10) / 10 }], () => setWeight(''));
  }
  function onSteps(e: FormEvent) {
    e.preventDefault();
    const v = parseNum(steps);
    if (v === null || !Number.isInteger(v)) return setError('Шаги: целое число за один день, например 7 500');
    void submit('steps', [{ metricType: 'steps', value: v }], () => setSteps(''));
  }
  function onCheckin(e: FormEvent) {
    e.preventDefault();
    const payloads: MeasurementPayload[] = [];
    const h = parseNum(sleepH);
    if (sleepH.trim()) {
      if (h === null || h < 0 || h > 24) return setError('Сон: часы от 0 до 24, например 7,5');
      payloads.push({ metricType: 'sleep_minutes', value: hoursToMinutes(h) });
    }
    if (quality) payloads.push({ metricType: 'sleep_quality', value: quality });
    if (energy) payloads.push({ metricType: 'energy', value: energy });
    if (!payloads.length) return setError('Заполни хотя бы одно поле — или пропусти, это необязательно');
    void submit('checkin', payloads, () => {
      setSleepH('');
      setQuality(null);
      setEnergy(null);
      setCheckinOpen(false);
    });
  }

  const checkinValue = hasCheckin
    ? [
        s.sleepMinutes !== null ? `сон ${minutesToHoursLabel(s.sleepMinutes)}` : null,
        s.sleepQuality !== null && SLEEP_QUALITY_LABELS[s.sleepQuality] ? `спал ${SLEEP_QUALITY_LABELS[s.sleepQuality]}` : null,
        s.energy !== null ? `энергия ${s.energy}/5` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : null;

  return (
    <Section
      title="Отметки сегодня"
      action={
        <button
          type="button"
          onClick={() => setHints((v) => !v)}
          aria-expanded={hints}
          aria-controls="health-hints"
          aria-label="Как отмечать"
          className={cn('-my-2 grid size-11 place-items-center rounded-xl text-muted hover:bg-surface-2 hover:text-text', hints && 'text-accent')}
        >
          <Info className="size-4" />
        </button>
      }
    >
      <Card className="px-3.5 py-1.5">
        {hints ? (
          <ul id="health-hints" className="mt-2 space-y-1 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">
            <li>Вес — лучше утром в похожих условиях, но не обязательно.</li>
            <li>Шаги — число за один день, а не недельная сумма из Apple Health.</li>
            <li>Вода — по жажде и с едой. Без отметок будет «нет данных», а не «не пил».</li>
          </ul>
        ) : null}
        {error ? (
          <Notice tone="danger" className="mt-2 flex items-start justify-between gap-2">
            <span>{error}</span>
            <button type="button" className="-my-1 min-h-8 shrink-0 text-xs underline" onClick={() => setError(null)}>
              скрыть
            </button>
          </Notice>
        ) : null}

        <div className="divide-y divide-border">
          <Row id="weight" icon={<Scale className="size-3.5" />} label="Вес" value={s.weight !== null ? `${nf.format(s.weight)} кг` : null}>
            <form onSubmit={onWeight} className="flex items-center gap-1.5">
              <div className="w-[9.5rem]">
                <Input aria-label="Вес, кг" inputMode="decimal" enterKeyHint="done" placeholder="например 53,2" value={weight} onChange={(e) => setWeight(e.target.value)} />
              </div>
              <Button type="submit" variant="soft" className="w-11 px-0" loading={busy === 'weight'} disabled={!weight.trim()} aria-label={s.weight !== null ? 'Изменить вес' : 'Сохранить вес'} icon={<Check className="size-5" />} />
            </form>
          </Row>

          <Row id="steps" icon={<Footprints className="size-3.5" />} label="Шаги" value={s.steps !== null ? nf.format(s.steps) : null}>
            <form onSubmit={onSteps} className="flex items-center gap-1.5">
              <div className="w-[9.5rem]">
                <Input aria-label="Шаги за день" inputMode="numeric" enterKeyHint="done" placeholder="например 7 500" value={steps} onChange={(e) => setSteps(e.target.value)} />
              </div>
              <Button type="submit" variant="soft" className="w-11 px-0" loading={busy === 'steps'} disabled={!steps.trim()} aria-label={s.steps !== null ? 'Изменить шаги' : 'Сохранить шаги'} icon={<Check className="size-5" />} />
            </form>
          </Row>

          <Row icon={<Droplet className="size-3.5" />} label="Вода" value={s.waterMl !== null ? `${nf.format(s.waterMl)} мл` : null}>
            <Button variant="soft" className="px-3" loading={busy === 'water250'} onClick={() => addWater(250)} aria-label="Добавить 250 мл воды">
              +250
            </Button>
            <Button variant="soft" className="px-3" loading={busy === 'water500'} onClick={() => addWater(500)} aria-label="Добавить 500 мл воды">
              +500
            </Button>
            {water.length ? (
              <Button variant="ghost" className="w-11 px-0 text-muted" onClick={() => removeMeasurement(water.at(-1)!.id)} aria-label="Убрать последнюю отметку воды" title="Убрать последнюю отметку" icon={<Undo2 className="size-4" />} />
            ) : null}
          </Row>

          <Row
            icon={<Moon className="size-3.5" />}
            label="Самочувствие утром"
            value={checkinValue}
            below={
              checkinOpen ? (
                <form onSubmit={onCheckin} className="mt-3 space-y-3 rounded-xl bg-surface-2 p-3">
                  <div className="max-w-40">
                    <Input label="Сон, часов" inputMode="decimal" placeholder="например 7,5" value={sleepH} onChange={(e) => setSleepH(e.target.value)} />
                  </div>
                  <div>
                    <p className="mb-1.5 text-sm font-medium">Как спал</p>
                    <Chips
                      ariaLabel="Как спал"
                      options={[1, 2, 3].map((v) => ({ value: v, label: SLEEP_QUALITY_LABELS[v]! }))}
                      value={quality ? [quality] : []}
                      onChange={(v) => setQuality(v[0] === quality ? null : (v[0] ?? null))}
                    />
                  </div>
                  <div>
                    <p className="mb-1.5 text-sm font-medium">Энергия, от 1 до 5</p>
                    <Chips ariaLabel="Энергия от 1 до 5" options={[1, 2, 3, 4, 5].map((v) => ({ value: v, label: String(v) }))} value={energy ? [energy] : []} onChange={(v) => setEnergy(v[0] === energy ? null : (v[0] ?? null))} />
                  </div>
                  <div className="flex gap-2">
                    <Button variant="ghost" onClick={() => setCheckinOpen(false)}>
                      Отмена
                    </Button>
                    <Button type="submit" variant="primary" className="flex-1" loading={busy === 'checkin'}>
                      Сохранить
                    </Button>
                  </div>
                </form>
              ) : null
            }
          >
            {checkinOpen ? null : (
              <Button variant="soft" className="px-3.5" onClick={() => setCheckinOpen(true)}>
                {hasCheckin ? 'Изменить' : 'Отметить'}
              </Button>
            )}
          </Row>
        </div>
      </Card>

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
    </Section>
  );
}
