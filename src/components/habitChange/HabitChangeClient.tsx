'use client';
import { Archive, Hand, Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { ProgramOverview } from '@/server/services/habitChange';
import { addDays, formatDateRu, formatDateShortRu, formatTime } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card, Section } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import { Chips, Input, Switch } from '@/components/ui/Field';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';

const PHASE: Record<string, string> = { baseline: 'наблюдение', reducing: 'снижение', quit: 'отказ', paused: 'пауза' };
const eur = (cents: number) => new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'EUR', maximumFractionDigits: cents % 100 ? 2 : 0 }).format(cents / 100);

function Bars({ days, today }: { days: { date: string; total: number | null; limit: number | null }[]; today: string }) {
  const max = Math.max(4, ...days.map((d) => Math.max(d.total ?? 0, d.limit ?? 0)));
  const H = 96;
  return (
    <figure>
      <div className="flex h-[112px] items-end gap-[3px]" role="img" aria-label="Количество по дням за 4 недели">
        {days.map((d) => {
          const h = d.total === null ? 0 : Math.max(3, (d.total / max) * H);
          const limitY = d.limit !== null ? (d.limit / max) * H : null;
          return (
            <div key={d.date} className="relative flex h-full flex-1 flex-col justify-end" title={`${formatDateShortRu(d.date)}: ${d.total ?? 'нет данных'}${d.limit !== null ? ` (лимит ${d.limit})` : ''}`}>
              {limitY !== null ? <span className="absolute inset-x-0 h-px bg-text/40" style={{ bottom: limitY }} /> : null}
              {d.total === null ? (
                <span className="mx-auto mb-0.5 size-1.5 rounded-full border border-faint" />
              ) : (
                <span className={cn('w-full rounded-t-[3px]', d.date === today ? 'bg-accent' : 'bg-accent/55')} style={{ height: h }} />
              )}
            </div>
          );
        })}
      </div>
      <figcaption className="mt-1 flex justify-between text-[11px] text-faint">
        <span>{formatDateShortRu(days[0]!.date)}</span>
        <span>линия — лимит · ○ — нет данных</span>
        <span>сегодня</span>
      </figcaption>
    </figure>
  );
}

function Setup() {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState('IQOS');
  const [unit, setUnit] = useState('стиков');
  const [pack, setPack] = useState('');
  const [perPack, setPerPack] = useState('20');
  const [busy, setBusy] = useState(false);
  async function create() {
    setBusy(true);
    try {
      await api('/api/habit-change', {
        body: {
          title,
          unitLabel: unit,
          pricePerPackCents: pack ? Math.round(Number(pack.replace(',', '.')) * 100) : null,
          unitsPerPack: pack ? Number(perPack) || null : null,
        },
      });
      router.refresh();
      toast.ok('Начали неделю наблюдения');
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold">Что хочешь изменить?</h2>
        <p className="mt-1 text-sm text-muted">
          Первая неделя — просто наблюдение: отмечай «+1» в момент, по желанию — причину. Потом вместе выберем мягкий лимит и будем снижать его понемногу. Срыв —
          это просто данные, прогресс не обнуляется.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Input label="Привычка" value={title} onChange={(e) => setTitle(e.target.value)} />
        <Input label="Единица (мн. ч.)" value={unit} onChange={(e) => setUnit(e.target.value)} />
        <Input label="Цена пачки, € (необязательно)" inputMode="decimal" placeholder="например 5,50" value={pack} onChange={(e) => setPack(e.target.value)} hint="для расчёта экономии" />
        <Input label="Штук в пачке" inputMode="numeric" value={perPack} onChange={(e) => setPerPack(e.target.value)} />
      </div>
      <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={create}>
        Начать наблюдение
      </Button>
    </Card>
  );
}

function Program({ o }: { o: ProgramOverview }) {
  const router = useRouter();
  const toast = useToast();
  const { tz } = useClientUser();
  const p = o.program;
  const [busy, setBusy] = useState<string | null>(null);
  const [startLimit, setStartLimit] = useState(String(o.baseline.suggestedLimit ?? ''));
  const [step, setStep] = useState(p.stepPerWeek || 1);
  const [totalDate, setTotalDate] = useState(addDays(o.today, -1));
  const [totalValue, setTotalValue] = useState('');
  const [quitDate, setQuitDate] = useState('');

  const run = async (key: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      router.refresh();
      if (ok) toast.ok(ok);
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const over = o.limit !== null && (o.todayTotal ?? 0) > o.limit;

  return (
    <div className="space-y-4">
      <Card className="p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h2 className="text-lg font-semibold">{p.title}</h2>
              <Badge tone={p.phase === 'baseline' ? 'neutral' : 'accent'}>{PHASE[p.phase]}</Badge>
            </div>
            <p className="tabular mt-1 text-3xl font-semibold">
              <span className={cn(over && 'text-warn')}>{o.todayTotal ?? 0}</span>
              {o.limit !== null ? <span className="text-lg font-normal text-muted"> из {o.limit}</span> : null}
              <span className="ml-1 text-base font-normal text-muted">{p.unitLabel} сегодня</span>
            </p>
            {o.todayResisted ? <p className="text-sm text-ok">Удержался сегодня: {o.todayResisted}</p> : null}
          </div>
          <div className="flex flex-col gap-2">
            <Button variant="primary" size="lg" icon={<Plus className="size-5" />} loading={busy === 'use'} onClick={() => run('use', () => api(`/api/habit-change/${p.id}/log`, { body: { kind: 'use' } }))}>
              1
            </Button>
            <Button size="sm" variant="ghost" icon={<Hand className="size-4" />} loading={busy === 'urge'} onClick={() => run('urge', () => api(`/api/habit-change/${p.id}/log`, { body: { kind: 'urge_resisted' } }), 'Отмечено: удержался')}>
              Удержался
            </Button>
          </div>
        </div>
        {p.alternatives.length ? <p className="mt-3 text-sm text-muted">Если тянет — попробуй: {p.alternatives.slice(0, 3).join(' · ').toLowerCase()}.</p> : null}
        {o.todayEvents.length ? (
          <ul className="mt-3 divide-y divide-border border-t border-border">
            {o.todayEvents.map((e) => (
              <li key={e.id} className="flex items-center gap-2 py-2 text-sm">
                <span className="tabular w-12 text-muted">{formatTime(e.occurredAt, tz)}</span>
                <span className="flex-1">
                  {e.kind === 'urge_resisted' ? 'Удержался' : e.kind === 'day_total' ? `Итог дня: ${e.quantity}` : `+${e.quantity}`}
                  {e.reason ? <span className="text-muted"> · {e.reason}</span> : null}
                </span>
                {e.kind === 'use' && !e.reason ? (
                  <select
                    aria-label="Причина"
                    className="min-h-9 max-w-36 rounded-lg border border-border bg-surface px-2 text-xs"
                    defaultValue=""
                    onChange={(ev) => ev.target.value && run('reason', () => api(`/api/habit-change/events/${e.id}`, { method: 'PATCH', body: { reason: ev.target.value } }))}
                  >
                    <option value="">причина…</option>
                    {p.reasons.map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                ) : null}
                <button type="button" aria-label="Удалить отметку" className="grid size-9 place-items-center rounded-lg text-faint hover:bg-surface-2" onClick={() => run('del', () => api(`/api/habit-change/events/${e.id}`, { method: 'DELETE' }))}>
                  <Trash2 className="size-4" />
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {p.phase === 'baseline' ? (
        <Card className="space-y-3 p-5">
          <h3 className="font-semibold">Неделя наблюдения</h3>
          <p className="text-sm text-muted">
            День {o.baseline.daysElapsed} из {o.baseline.needed}, дней с отметками: {o.baseline.daysWithData}. {o.baseline.perDay !== null ? `Пока в среднем ${o.baseline.perDay} в день.` : 'Пока нет данных.'}
          </p>
          <div className="h-2 overflow-hidden rounded-full bg-surface-2">
            <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round((o.baseline.daysElapsed / o.baseline.needed) * 100)}%` }} />
          </div>
          {o.baseline.ready || o.baseline.daysWithData >= 3 ? (
            <div className="space-y-3 border-t border-border pt-3">
              <p className="text-sm">{o.baseline.ready ? 'Наблюдение завершено.' : 'Данных уже достаточно, можно начать раньше.'} Предлагаю мягкий старт:</p>
              <div className="flex flex-wrap items-end gap-3">
                <Input label="Лимит в день" inputMode="numeric" value={startLimit} onChange={(e) => setStartLimit(e.target.value)} className="w-28" />
                <div className="space-y-1.5">
                  <p className="text-sm font-medium">Снижать каждую неделю на</p>
                  <Chips ariaLabel="Шаг снижения" options={[0, 1, 2].map((n) => ({ value: n, label: n === 0 ? 'не снижать' : String(n) }))} value={[step]} onChange={(v) => setStep(v[0]!)} />
                </div>
              </div>
              <Button variant="primary" loading={busy === 'plan'} disabled={startLimit === '' || Number.isNaN(Number(startLimit))} onClick={() => run('plan', () => api(`/api/habit-change/${p.id}/plan`, { body: { direction: 'reduce', dailyLimit: Number(startLimit), stepPerWeek: step } }), 'План снижения начат')}>
                Начать снижение
              </Button>
            </div>
          ) : null}
        </Card>
      ) : (
        <Card className="space-y-2 p-5 text-sm">
          <h3 className="text-[15px] font-semibold">План</h3>
          {o.baseline.perDay !== null ? <p className="text-muted">Исходный уровень: {o.baseline.perDay} в день.</p> : null}
          {o.limit !== null ? <p>Сегодня лимит: <b>{o.limit}</b>{o.nextWeekLimit !== null && o.nextWeekLimit !== o.limit ? `, через неделю — ${o.nextWeekLimit}` : ''}.</p> : null}
          {p.direction === 'quit' && p.quitDate ? <p>Дата отказа: {formatDateRu(p.quitDate)}.</p> : null}
          <p className="text-muted">
            Неделя: в пределах лимита {o.week.withinLimit}, выше — {o.week.overLimit}, без данных — {o.week.unknown}.
          </p>
          {o.savings.daysCounted ? (
            <p className="text-ok">
              С начала плана: на {o.savings.units} {p.unitLabel} меньше{o.savings.cents !== null ? ` · примерно ${eur(o.savings.cents)}` : ''}.
            </p>
          ) : null}
        </Card>
      )}

      <Card className="p-5">
        <h3 className="mb-3 text-[15px] font-semibold">4 недели</h3>
        <Bars days={o.days28} today={o.today} />
      </Card>

      {o.reasonsWeek.length || o.patterns.length ? (
        <Card className="space-y-3 p-5 text-sm">
          {o.reasonsWeek.length ? (
            <div>
              <h3 className="text-[15px] font-semibold">Причины за неделю</h3>
              <ul className="mt-2 space-y-1">
                {o.reasonsWeek.map(([r, n]) => (
                  <li key={r} className="flex justify-between">
                    <span>{r}</span>
                    <span className="tabular text-muted">{n}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {o.patterns.length ? (
            <div>
              <h3 className="text-[15px] font-semibold">Что видно по данным</h3>
              <ul className="mt-2 space-y-2">
                {o.patterns.map((x) => (
                  <li key={x.key}>
                    {x.text} <span className="text-xs text-faint">({x.basedOn})</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Card>
      ) : null}

      <Card className="space-y-3 p-5">
        <h3 className="text-[15px] font-semibold">Итог дня вместо отметок</h3>
        <p className="text-sm text-muted">Если неудобно отмечать каждый раз — введи число за день. Оно заменит отметки за этот день.</p>
        <div className="flex flex-wrap items-end gap-2">
          <Input type="date" aria-label="День" value={totalDate} max={o.today} onChange={(e) => setTotalDate(e.target.value)} className="w-auto" />
          <Input aria-label="Сколько" inputMode="numeric" placeholder="число" value={totalValue} onChange={(e) => setTotalValue(e.target.value)} className="w-24" />
          <Button loading={busy === 'total'} disabled={totalValue === ''} onClick={() => run('total', () => api(`/api/habit-change/${p.id}/day-total`, { body: { date: totalDate, total: Number(totalValue) } }), 'Итог дня сохранён')}>
            Сохранить
          </Button>
        </div>
      </Card>

      <Card className="space-y-3 p-5">
        <h3 className="text-[15px] font-semibold">Если решишь бросить совсем</h3>
        <p className="text-sm text-muted">
          Можно назначить дату — с неё лимит станет 0. С никотиновой зависимостью лучше не оставаться одному: в Португалии при центрах здоровья SNS есть консультации по
          отказу от курения, а средства вроде никотинозаместительной терапии стоит обсуждать с врачом. Приложение помогает с привычкой, но не заменяет медицинскую помощь.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <Input type="date" aria-label="Дата отказа" value={quitDate} min={o.today} onChange={(e) => setQuitDate(e.target.value)} className="w-auto" />
          <Button
            loading={busy === 'quit'}
            disabled={!quitDate}
            onClick={() => run('quit', () => api(`/api/habit-change/${p.id}/plan`, { body: { direction: 'quit', dailyLimit: o.limit ?? Math.ceil(o.baseline.perDay ?? 0), stepPerWeek: p.stepPerWeek, quitDate } }), 'Дата отказа назначена')}
          >
            Назначить дату
          </Button>
        </div>
      </Card>

      <Card className="divide-y divide-border px-5">
        <Switch label="Показывать на экране «Сегодня»" checked={p.showOnToday} onChange={(v) => run('today', () => api(`/api/habit-change/${p.id}`, { method: 'PATCH', body: { showOnToday: v } }))} />
        <Switch
          label="Пауза"
          description="например, во время болезни — дни не считаются"
          checked={p.phase === 'paused'}
          onChange={(v) => run('pause', () => api(`/api/habit-change/${p.id}`, { method: 'PATCH', body: { phase: v ? 'paused' : p.dailyLimit !== null ? (p.direction === 'quit' ? 'quit' : 'reducing') : 'baseline' } }))}
        />
        <div className="py-2">
          <Button variant="ghost" size="sm" icon={<Archive className="size-4" />} loading={busy === 'archive'} onClick={() => run('archive', () => api(`/api/habit-change/${p.id}`, { method: 'DELETE' }), 'Перенесено в архив')}>
            В архив
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function HabitChangeClient({ programs }: { programs: ProgramOverview[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-2xl font-semibold">Изменение привычек</h1>
        <p className="text-sm text-muted">Без стыда и обнулений: сначала понять, когда и почему, потом мягко снижать.</p>
      </header>
      {programs.length ? programs.map((o) => <Program key={o.program.id} o={o} />) : <Setup />}
      {programs.length ? (
        adding ? (
          <Section title="Ещё одна привычка">
            <Setup />
          </Section>
        ) : (
          <Button variant="ghost" onClick={() => setAdding(true)} icon={<Plus className="size-4" />}>
            Добавить другую привычку
          </Button>
        )
      ) : null}
      {!programs.length ? (
        <Card>
          <EmptyState title="Например: IQOS, телефон перед сном, откладывание дел">Любая привычка, которую хочется сократить. Можно несколько, но лучше начать с одной.</EmptyState>
        </Card>
      ) : null}
      <Notice>Награды здесь — за дни в пределах плана, а не за «невыкуренные» штуки: так статистику не хочется подгонять.</Notice>
    </div>
  );
}
