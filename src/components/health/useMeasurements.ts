'use client';
import { useState } from 'react';
import { ApiError, api } from '@/lib/api';
import type { MetricType } from '@/domain/types';

export interface MeasurementPayload {
  metricType: MetricType;
  value: number;
  localDate?: string;
  sourceType?: 'manual';
}

export interface Duplicate {
  payload: MeasurementPayload;
  message: string;
  existing: { value: number; unit: string };
}

/**
 * Saves measurements; a 409 DUPLICATE_FOR_DATE is collected instead of thrown so the screen can ask
 * «Заменить?» once and resend with replace: true (HEALTH-01, PRD §7.5).
 */
export function useMeasurements() {
  const [pending, setPending] = useState<Duplicate[]>([]);

  async function save(payloads: MeasurementPayload[]): Promise<{ saved: { id: string; metricType: MetricType }[]; duplicates: Duplicate[] }> {
    const saved: { id: string; metricType: MetricType }[] = [];
    const duplicates: Duplicate[] = [];
    for (const p of payloads) {
      try {
        const r = await api<{ measurement: { id: string; metricType: MetricType } }>('/api/health/measurements', { body: { sourceType: 'manual', ...p } });
        saved.push(r.measurement);
      } catch (e) {
        if (e instanceof ApiError && e.code === 'DUPLICATE_FOR_DATE') {
          const existing = (e.details as { existing?: { value: number; unit: string } } | undefined)?.existing ?? { value: NaN, unit: '' };
          duplicates.push({ payload: p, message: e.message, existing });
        } else throw e;
      }
    }
    setPending(duplicates);
    return { saved, duplicates };
  }

  async function replaceAll(): Promise<number> {
    let n = 0;
    for (const d of pending) {
      await api('/api/health/measurements', { body: { sourceType: 'manual', ...d.payload, replace: true } });
      n++;
    }
    setPending([]);
    return n;
  }

  return { save, pending, replaceAll, dismiss: () => setPending([]) };
}
