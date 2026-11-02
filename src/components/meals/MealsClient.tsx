'use client';
import { ChevronLeft, ChevronRight, Pencil, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { CONSUMPTION_LABELS, MEAL_SLOT_LABELS, type ConsumptionStatus, type MealSlot } from '@/domain/types';
import { addDays, formatDateRu, formatDateShortRu, formatTime, isoWeekday, weekdayShort } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select, Switch } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { EmptyState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';
import { useClientUser } from '@/components/shell/UserContext';
import { CATEGORY_LABELS, TemplateSheet, type MealTemplate } from './TemplateSheet';

export const HOME_DISH = 'Домашнее блюдо — уточнить по факту';

export interface PlanEntry {
  localDate: string;
  mealSlot: MealSlot;
  templateId: string | null;
  description: string | null;
  templateTitle: string | null;
}

export interface MealLog {
  id: string;
  localDate: string;
  mealSlot: MealSlot;
  eatenAt: string;
  description: string | null;
  consumptionStatus: ConsumptionStatus;
  source: string;
}

function usePlan() {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  async function set(localDate: string, slot: MealSlot, templateId: string | null, description: string | null) {
    setBusy(`${localDate}:${slot}`);
    try {
      await api('/api/meals/plan', { body: { localDate, slot, templateId, description } });
      router.refresh();
      return true;
    } catch (e) {
      toast.error(errorMessage(e));
      return false;
    } finally {
      setBusy(null);
    }
  }
  return { set, busy };
}

function HomeDish({ date, slot, entry, plan }: { date: string; slot: 'lunch' | 'dinner'; entry: PlanEntry | undefined; plan: ReturnType<typeof usePlan> }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(entry?.description ?? '');
  const busy = plan.busy === `${date}:${slot}`;
  if (editing) {
    return (
      <form
        className="flex gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (await plan.set(date, slot, null, text.trim() || null)) setEditing(false);
        }}
      >
        <Input aria-label={`${MEAL_SLOT_LABELS[slot]}: описание`} autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="например, плов соседки" maxLength={300} className="min-w-0 flex-1" />
        <Button type="submit" variant="soft" loading={busy}>
          OK
        </Button>
      </form>
    );
  }
  return (
    <button type="button" onClick={() => { setText(entry?.description ?? ''); setEditing(true); }} className="flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-3 text-left hover:bg-surface-2">
      <span className={cn('min-w-0 truncate text-[15px]', !entry?.description && 'text-muted')}>{entry?.description ?? HOME_DISH}</span>
      <Pencil className="size-4 shrink-0 text-faint" aria-hidden="true" />
    </button>
  );
}

function WeekMenu({ weekStart, days, plan: entries, templates }: { weekStart: string; days: string[]; plan: PlanEntry[]; templates: MealTemplate[] }) {
  const plan = usePlan();
  const { today } = useClientUser();
  const [picked, setDay] = useState(today);
  const day = days.includes(picked) ? picked : days.includes(today) ? today : days[0]!;
  const breakfasts = templates.filter((t) => t.category === 'breakfast' && t.enabled);
  const get = (d: string, s: MealSlot) => entries.find((e) => e.localDate === d && e.mealSlot === s);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/health/meals?week=${addDays(weekStart, -7)}`} aria-label="Предыдущая неделя" className="grid size-11 place-items-center rounded-xl border border-border bg-surface hover:bg-surface-2">
          <ChevronLeft className="size-5" />
        </Link>
        <p className="text-sm font-medium">
          {formatDateShortRu(weekStart)} – {formatDateShortRu(addDays(weekStart, 6))}
        </p>
        <Link href={`/health/meals?week=${addDays(weekStart, 7)}`} aria-label="Следующая неделя" className="grid size-11 place-items-center rounded-xl border border-border bg-surface hover:bg-surface-2">
          <ChevronRight className="size-5" />
        </Link>
      </div>
      <Segmented
        ariaLabel="День недели"
        className="lg:hidden"
        value={day}
        onChange={setDay}
        options={days.map((d) => ({ value: d, label: weekdayShort(isoWeekday(d)) }))}
      />
      <div className="grid gap-3 lg:grid-cols-2">
        {days.map((d) => {
          const b = get(d, 'breakfast');
          return (
            <Card key={d} className={cn('p-3', d === today && 'border-accent', d !== day && 'hidden lg:block')}>
              <p className="mb-2 px-1 text-sm font-semibold">
                {formatDateRu(d)}
                {d === today ? <span className="ml-2 text-xs font-normal text-accent">сегодня</span> : null}
              </p>
              <dl className="space-y-1.5">
                <div>
                  <dt className="px-1 text-xs text-muted">Завтрак</dt>
                  <dd>
                    <Select
                      aria-label={`Завтрак, ${formatDateRu(d)}`}
                      value={b?.templateId ?? ''}
                      disabled={plan.busy === `${d}:breakfast`}
                      onChange={(e) => void plan.set(d, 'breakfast', e.target.value || null, null)}
                    >
                      <option value="">— не выбран —</option>
                      {breakfasts.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.title}
                        </option>
                      ))}
                      {b?.templateId && !breakfasts.some((t) => t.id === b.templateId) ? <option value={b.templateId}>{b.templateTitle ?? 'Шаблон выключен'}</option> : null}
                    </Select>
                  </dd>
                </div>
                {(['lunch', 'dinner'] as const).map((slot) => (
                  <div key={slot}>
                    <dt className="px-1 text-xs text-muted">{MEAL_SLOT_LABELS[slot]}</dt>
                    <dd>
                      <HomeDish key={`${d}:${slot}:${get(d, slot)?.description ?? ''}`} date={d} slot={slot} entry={get(d, slot)} plan={plan} />
                    </dd>
                  </div>
                ))}
              </dl>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function Catalog({ templates }: { templates: MealTemplate[] }) {
  const router = useRouter();
  const toast = useToast();
  const [edit, setEdit] = useState<{ t: MealTemplate | null; n: number } | null>(null);
  const [opened, setOpened] = useState(0);
  const openEdit = (t: MealTemplate | null) => {
    setOpened((n) => n + 1);
    setEdit({ t, n: opened + 1 });
  };
  const [busy, setBusy] = useState<string | null>(null);
  const groups = Object.keys(CATEGORY_LABELS)
    .map((c) => ({ c, items: templates.filter((t) => t.category === c) }))
    .filter((g) => g.items.length);

  async function toggle(t: MealTemplate, enabled: boolean) {
    setBusy(t.id);
    try {
      await api(`/api/meals/templates/${t.id}`, { method: 'PATCH', body: { enabled } });
      router.refresh();
    } catch (e) {
      toast.error(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button variant="soft" icon={<Plus className="size-4" />} onClick={() => openEdit(null)}>
          Свой шаблон
        </Button>
      </div>
      {groups.length ? (
        groups.map((g) => (
          <Card key={g.c} className="p-1.5">
            <p className="px-3 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-muted">{CATEGORY_LABELS[g.c]}</p>
            <ul className="divide-y divide-border">
              {g.items.map((t) => (
                <li key={t.id} className="flex items-center gap-2 px-3 py-2">
                  <button type="button" onClick={() => openEdit(t)} className="min-h-11 min-w-0 flex-1 text-left">
                    <span className={cn('flex flex-wrap items-center gap-1.5 text-[15px]', !t.enabled && 'text-faint')}>
                      {t.title}
                      {t.isExample ? <Badge>пример</Badge> : null}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {[t.prepMinutes ? `${t.prepMinutes} мин` : null, t.ingredientsJson.map((i) => i.name).join(', ') || 'состав не указан'].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                  <div className="shrink-0">
                    <Switch checked={t.enabled} disabled={busy === t.id} onChange={(v) => toggle(t, v)} label={<span className="sr-only">{t.enabled ? 'Выключить' : 'Включить'} «{t.title}»</span>} />
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        ))
      ) : (
        <Card>
          <EmptyState title="Шаблонов пока нет">Добавь свой завтрак или перекус — из них соберётся меню и список покупок.</EmptyState>
        </Card>
      )}
      <TemplateSheet key={edit?.n ?? 0} open={!!edit} template={edit?.t ?? null} onClose={() => setEdit(null)} />
    </div>
  );
}

function RecentLogs({ logs }: { logs: MealLog[] }) {
  const { tz } = useClientUser();
  if (!logs.length) {
    return (
      <Card>
        <EmptyState title="Отметок пока нет">Отметь приём пищи на экране «Сегодня» или «Здоровье» — «Съел всё», «Часть», «Заменил» или «Не ел».</EmptyState>
      </Card>
    );
  }
  return (
    <Card className="p-1.5">
      <ul className="divide-y divide-border">
        {[...logs].reverse().map((l) => (
          <li key={l.id} className="flex items-start justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-[15px]">
                {MEAL_SLOT_LABELS[l.mealSlot]} <span className="text-sm text-muted">· {formatDateShortRu(l.localDate)}, {formatTime(l.eatenAt, tz)}</span>
              </p>
              {l.description ? <p className="truncate text-sm text-muted">{l.description}</p> : null}
            </div>
            <Badge tone={l.consumptionStatus === 'not_eaten' ? 'neutral' : 'ok'}>{CONSUMPTION_LABELS[l.consumptionStatus]}</Badge>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export { WeekMenu, Catalog, RecentLogs };
