import type { DateTime } from 'luxon';
import { z } from 'zod';
import { addDays, isLocalDate, localDateOf, zoned, type LocalDate } from '@/domain/time';
import type { MetricType } from '@/domain/types';
import {
  clampRange,
  denseSeries,
  stepsStats,
  trailingAverage,
  TREND_MIN_POINTS,
  TREND_WINDOW_DAYS,
  weightStats,
  type StepsStats,
  type WeightStats,
} from '@/domain/health/series';
import { one, type Tx } from '../db';
import { AppError } from '../http';
import { audit } from './audit';
import type { UserContext } from './profile';

/**
 * Measurements with provenance (PRD §7, §11.8): every value keeps source_type, optional media and
 * confidence; AI values are stored only after explicit user confirmation. "No data" ≠ zero.
 */

export const METRIC_RULES: Record<MetricType, { unit: string; min: number; max: number; integer?: boolean; daily: boolean; label: string }> = {
  weight: { unit: 'кг', min: 20, max: 400, daily: true, label: 'Вес' },
  steps: { unit: 'шагов', min: 0, max: 150000, integer: true, daily: true, label: 'Шаги' },
  sleep_minutes: { unit: 'мин', min: 0, max: 1440, integer: true, daily: true, label: 'Сон' },
  sleep_quality: { unit: 'балл', min: 1, max: 3, integer: true, daily: true, label: 'Качество сна' },
  energy: { unit: 'балл', min: 1, max: 5, integer: true, daily: true, label: 'Энергия' },
  water_ml: { unit: 'мл', min: 1, max: 5000, integer: true, daily: false, label: 'Вода' },
};

export const measurementInputSchema = z.object({
  metricType: z.enum(['weight', 'steps', 'sleep_minutes', 'sleep_quality', 'energy', 'water_ml']),
  value: z.number(),
  localDate: z.string().refine(isLocalDate).optional(),
  time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  sourceType: z.enum(['manual', 'telegram', 'photo', 'screenshot', 'health_import', 'ai_estimate']).default('manual'),
  sourceMediaId: z.string().uuid().nullable().optional(),
  aiConfidence: z.number().min(0).max(1).nullable().optional(),
  replace: z.boolean().default(false),
  notes: z.string().max(300).nullable().optional(),
});
export type MeasurementInput = z.infer<typeof measurementInputSchema>;

export interface MeasurementRow {
  id: string;
  metricType: MetricType;
  value: number;
  unit: string;
  measuredAt: Date;
  localDate: string;
  sourceType: string;
  sourceMediaId: string | null;
  aiConfidence: number | null;
  userConfirmedAt: Date | null;
  notes: string | null;
}

export async function addMeasurement(tx: Tx, ctx: UserContext, now: DateTime, input: MeasurementInput): Promise<MeasurementRow> {
  const rule = METRIC_RULES[input.metricType];
  const value = input.metricType === 'weight' ? Math.round(input.value * 10) / 10 : input.value;
  if (value < rule.min || value > rule.max || (rule.integer && !Number.isInteger(value))) {
    throw new AppError('VALUE_OUT_OF_RANGE', `${rule.label}: значение вне допустимого диапазона (${rule.min}–${rule.max})`, 422);
  }
  const today = localDateOf(now, ctx.tz);
  const localDate = input.localDate ?? today;
  if (localDate > today) throw new AppError('FUTURE_DATE', 'Нельзя записать измерение на будущую дату', 422);
  const measuredAt = input.time ? zoned(localDate, input.time, ctx.tz) : localDate === today ? now : zoned(localDate, '12:00', ctx.tz);

  if (rule.daily) {
    const [existing] = await tx<MeasurementRow[]>`
      select * from health_measurements where user_id = ${ctx.userId} and metric_type = ${input.metricType} and local_date = ${localDate}`;
    if (existing && !input.replace) {
      throw new AppError('DUPLICATE_FOR_DATE', `За ${localDate} уже есть значение ${existing.value} ${existing.unit}. Заменить?`, 409, {
        existing: serializeMeasurement(existing),
      });
    }
    if (existing) {
      const row = one(await tx<MeasurementRow[]>`
        update health_measurements set value = ${value}, measured_at = ${measuredAt.toJSDate()}, source_type = ${input.sourceType},
          source_media_id = ${input.sourceMediaId ?? null}, ai_confidence = ${input.aiConfidence ?? null},
          user_confirmed_at = now(), notes = ${input.notes ?? null}
        where id = ${existing.id} returning *`);
      await audit(tx, ctx.userId, 'health_measurement', row.id, 'replaced', { metric: input.metricType, from: existing.value, to: value });
      return row;
    }
  }
  const row = one(await tx<MeasurementRow[]>`
    insert into health_measurements (user_id, metric_type, value, unit, measured_at, local_date, source_type, source_media_id, ai_confidence, user_confirmed_at, notes)
    values (${ctx.userId}, ${input.metricType}, ${value}, ${rule.unit}, ${measuredAt.toJSDate()}, ${localDate}, ${input.sourceType},
            ${input.sourceMediaId ?? null}, ${input.aiConfidence ?? null}, now(), ${input.notes ?? null})
    returning *`);
  await audit(tx, ctx.userId, 'health_measurement', row.id, 'created', { metric: input.metricType, source: input.sourceType });
  return row;
}

export function serializeMeasurement(m: MeasurementRow) {
  return { ...m, measuredAt: m.measuredAt.toISOString(), userConfirmedAt: m.userConfirmedAt?.toISOString() ?? null };
}

export async function listMeasurements(tx: Tx, userId: string, metric: MetricType | null, from: LocalDate, to: LocalDate) {
  return tx<MeasurementRow[]>`
    select * from health_measurements
    where user_id = ${userId} and (${metric}::text is null or metric_type = ${metric}) and local_date between ${from} and ${to}
    order by local_date, measured_at`;
}

export async function deleteMeasurement(tx: Tx, userId: string, id: string) {
  const rows = await tx`delete from health_measurements where id = ${id} and user_id = ${userId} returning id`;
  if (!rows.length) throw new AppError('NOT_FOUND', 'Измерение не найдено', 404);
  await audit(tx, userId, 'health_measurement', id, 'deleted', {});
}

export interface DaySummary {
  date: LocalDate;
  weight: number | null;
  steps: number | null;
  waterMl: number | null;
  sleepMinutes: number | null;
  sleepQuality: number | null;
  energy: number | null;
}

export async function daySummary(tx: Tx, userId: string, date: LocalDate): Promise<DaySummary> {
  const rows = await tx<{ metricType: MetricType; total: number; n: number }[]>`
    select metric_type, sum(value)::float as total, count(*)::int as n from health_measurements
    where user_id = ${userId} and local_date = ${date} group by metric_type`;
  const get = (m: MetricType) => rows.find((r) => r.metricType === m)?.total ?? null;
  return {
    date,
    weight: get('weight'),
    steps: get('steps'),
    waterMl: get('water_ml'),
    sleepMinutes: get('sleep_minutes'),
    sleepQuality: get('sleep_quality'),
    energy: get('energy'),
  };
}

/** Daily series with explicit nulls for days without data (HEALTH-05). */
export async function dailySeries(tx: Tx, userId: string, metric: MetricType, from: LocalDate, to: LocalDate) {
  const rows = await tx<{ localDate: string; total: number }[]>`
    select local_date, sum(value)::float as total from health_measurements
    where user_id = ${userId} and metric_type = ${metric} and local_date between ${from} and ${to}
    group by local_date order by local_date`;
  const map = new Map(rows.map((r) => [r.localDate, r.total]));
  const out: { date: LocalDate; value: number | null }[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push({ date: d, value: map.get(d) ?? null });
  return out;
}

// ---------------------------------------------------------------------------
// summary for charts (HEALTH-05: explicit nulls; weight trend only with enough points)
// ---------------------------------------------------------------------------
export interface HealthSummaryDay {
  date: LocalDate;
  weight: number | null;
  weightAvg7: number | null;
  steps: number | null;
  waterMl: number | null;
  sleepMinutes: number | null;
  sleepQuality: number | null;
  energy: number | null;
}

export interface HealthSummary {
  from: LocalDate;
  to: LocalDate;
  days: HealthSummaryDay[];
  weight: WeightStats;
  steps: StepsStats;
  trend: { windowDays: number; minPoints: number };
}

export async function healthSummary(tx: Tx, userId: string, fromRaw: LocalDate, toRaw: LocalDate): Promise<HealthSummary> {
  const { from, to } = clampRange(fromRaw, toRaw);
  const historyFrom = addDays(from, -(TREND_WINDOW_DAYS - 1));
  const rows = await tx<{ metricType: MetricType; localDate: string; total: number }[]>`
    select metric_type, local_date, sum(value)::float as total from health_measurements
    where user_id = ${userId} and local_date between ${historyFrom} and ${to}
    group by metric_type, local_date`;
  const byMetric = (m: MetricType, start: LocalDate) =>
    new Map(rows.filter((r) => r.metricType === m && r.localDate >= start).map((r) => [r.localDate, r.total]));
  const weight = denseSeries(from, to, byMetric('weight', from));
  const weightHistory = denseSeries(historyFrom, addDays(from, -1), byMetric('weight', historyFrom));
  const trend = trailingAverage(weight, weightHistory);
  const steps = denseSeries(from, to, byMetric('steps', from));
  const water = byMetric('water_ml', from);
  const sleep = byMetric('sleep_minutes', from);
  const quality = byMetric('sleep_quality', from);
  const energy = byMetric('energy', from);
  const days = weight.map((w, i) => ({
    date: w.date,
    weight: w.value,
    weightAvg7: trend[i] ?? null,
    steps: steps[i]?.value ?? null,
    waterMl: water.get(w.date) ?? null,
    sleepMinutes: sleep.get(w.date) ?? null,
    sleepQuality: quality.get(w.date) ?? null,
    energy: energy.get(w.date) ?? null,
  }));
  return {
    from,
    to,
    days,
    weight: weightStats(weight, trend),
    steps: stepsStats(steps),
    trend: { windowDays: TREND_WINDOW_DAYS, minPoints: TREND_MIN_POINTS },
  };
}

/** Today block of the health screen: values for exactly this local date + water entries to undo. */
export async function healthToday(tx: Tx, ctx: UserContext, now: DateTime) {
  const today = localDateOf(now, ctx.tz);
  const summary = await daySummary(tx, ctx.userId, today);
  const rows = await listMeasurements(tx, ctx.userId, null, today, today);
  return {
    date: today,
    summary,
    measurements: rows.map(serializeMeasurement),
  };
}
