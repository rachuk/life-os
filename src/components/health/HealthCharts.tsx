'use client';
import { useEffect, useState } from 'react';
import type { HealthSummary } from '@/server/services/health';
import { addDays } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Card, CardHeader } from '@/components/ui/Card';
import { Segmented } from '@/components/ui/Segmented';
import { Notice } from '@/components/ui/States';
import { ChartTable, StepsChart, WeightChart } from './charts';

type Range = '14' | '30' | '90';
const nf = new Intl.NumberFormat('ru-RU');

/** Weight + steps dynamics. One range control scopes both charts; refetch keeps the old frame dimmed. */
export function HealthCharts({ initial, today }: { initial: HealthSummary; today: string }) {
  const [range, setRange] = useState<Range>('30');
  // other ranges are cached against the server snapshot they were loaded with, so a refresh after a
  // new measurement reloads them instead of showing stale numbers
  const [fetched, setFetched] = useState<Partial<Record<Range, { base: HealthSummary; s: HealthSummary }>>>({});
  const [error, setError] = useState<string | null>(null);
  const cached = fetched[range];
  const fresh = range === '30' || cached?.base === initial;

  useEffect(() => {
    if (fresh) return;
    let cancelled = false;
    api<HealthSummary>(`/api/health/summary?from=${addDays(today, -(Number(range) - 1))}&to=${today}`)
      .then((s) => {
        if (!cancelled) setFetched((f) => ({ ...f, [range]: { base: initial, s } }));
      })
      .catch((e) => {
        if (!cancelled) setError(errorMessage(e));
      });
    return () => {
      cancelled = true;
    };
  }, [fresh, range, initial, today]);

  function choose(r: Range) {
    setError(null);
    setRange(r);
  }

  const data = range === '30' ? initial : (cached?.s ?? initial);
  const dim = !fresh && !error;
  const days = data.days;
  const hasWeight = data.weight.count > 0;
  const hasSteps = data.steps.knownDays > 0;

  return (
    <div className="space-y-3">
      <Segmented
        ariaLabel="Период"
        value={range}
        onChange={choose}
        options={[
          { value: '14', label: '2 недели' },
          { value: '30', label: '30 дней' },
          { value: '90', label: '90 дней' },
        ]}
        className="w-fit"
      />
      {error ? <Notice tone="danger">{error}</Notice> : null}

      <Card className="pb-3" aria-labelledby="chart-weight">
        <CardHeader
          title={<span id="chart-weight">Вес</span>}
          subtitle={
            hasWeight
              ? `Замеров: ${data.weight.count}${data.weight.latestTrend !== null ? ` · средняя за 7 дней ${nf.format(data.weight.latestTrend)} кг` : ''}`
              : 'За период нет замеров'
          }
        />
        <div className="px-3 pt-2">
          {hasWeight ? (
            <>
              <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2 rounded-full bg-[var(--muted)]" /> Замер
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="h-0.5 w-4 rounded bg-accent" /> Средняя за 7 дней (от {data.trend.minPoints} замеров)
                </span>
              </div>
              <WeightChart days={days} dim={dim} />
              <p className="px-1 text-xs text-muted">Смотри на тренд, а не на отдельный день. Взвешиваться каждый день не обязательно.</p>
              <ChartTable days={days} metric="weight" />
            </>
          ) : (
            <p className="px-1 pb-2 text-sm text-muted">Добавь вес выше. Средняя линия появится, когда за 7 дней наберётся хотя бы {data.trend.minPoints} замера.</p>
          )}
        </div>
      </Card>

      <Card className="pb-3" aria-labelledby="chart-steps">
        <CardHeader
          title={<span id="chart-steps">Шаги</span>}
          subtitle={
            hasSteps
              ? `В среднем ${nf.format(data.steps.averageKnown ?? 0)} за дни с данными · без данных: ${data.steps.unknownDays} дн.`
              : 'За период нет данных о шагах'
          }
        />
        <div className="px-3 pt-2">
          {hasSteps ? (
            <>
              <div className="mb-1 flex flex-wrap gap-x-4 gap-y-1 px-1 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2.5 rounded-[3px] bg-accent" /> Шаги за день
                </span>
                <span className="flex items-center gap-1.5">
                  <span aria-hidden="true" className="size-2 rounded-full border-[1.5px] border-[var(--faint)]" /> Нет данных (это не 0)
                </span>
              </div>
              <StepsChart days={days} dim={dim} />
              <ChartTable days={days} metric="steps" />
            </>
          ) : (
            <p className="px-1 pb-2 text-sm text-muted">Внеси шаги за день вручную. Дни без записи остаются «нет данных», а не нулём.</p>
          )}
        </div>
      </Card>
    </div>
  );
}
