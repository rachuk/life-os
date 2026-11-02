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
import { Chips, Input, Switch } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
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

const EMPTY_TEXT: Record<'breakfast' | 'lunch' | 'dinner', string> = { breakfast: 'Не выбран', lunch: 'Домашнее блюдо', dinner: 'Домашнее блюдо' };
const PLACEHOLDER: Record<'breakfast' | 'lunch' | 'dinner', string> = { breakfast: 'например, сырники', lunch: 'например, плов соседки', dinner: 'например, гречка с курицей' };
type PlanSlot = keyof typeof EMPTY_TEXT;

/** One planned meal: the same row + sheet for breakfast, lunch and dinner — a template or own text. */
function SlotRow({ date, slot, entry, onOpen }: { date: string; slot: PlanSlot; entry: PlanEntry | undefined; onOpen: () => void }) {
  const value = entry?.templateTitle ?? entry?.description ?? null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`${MEAL_SLOT_LABELS[slot]}, ${formatDateRu(date)}: ${value ?? EMPTY_TEXT[slot]} — изменить`}
      className="flex min-h-12 w-full items-center justify-between gap-2 rounded-xl px-2.5 py-1.5 text-left hover:bg-surface-2"
    >
      <span className="min-w-0">
        <span className="block text-xs text-muted">{MEAL_SLOT_LABELS[slot]}</span>
        <span className={cn('block truncate text-[15px]', !value && 'text-muted')}>{value ?? EMPTY_TEXT[slot]}</span>
      </span>
      <Pencil className="size-4 shrink-0 text-muted" aria-hidden="true" />
    </button>
  );
}

function SlotSheet({
  target,
  templates,
  plan,
  onClose,
}: {
  target: { date: string; slot: PlanSlot; entry: PlanEntry | undefined } | null;
  templates: MealTemplate[];
  plan: ReturnType<typeof usePlan>;
  onClose: () => void;
}) {
  // initialised on mount; the parent remounts the sheet (key) for every slot it opens
  const [templateId, setTemplateId] = useState<string | null>(target?.entry?.templateId ?? null);
  const [text, setText] = useState(target?.entry?.templateId ? '' : (target?.entry?.description ?? ''));
  if (!target) return null;
  const { date, slot, entry } = target;
  const options = templates.filter((t) => t.category === slot && (t.enabled || t.id === entry?.templateId));
  const busy = plan.busy === `${date}:${slot}`;
  const save = async (tid: string | null, desc: string | null) => {
    if (await plan.set(date, slot, tid, desc)) onClose();
  };
  return (
    <Sheet
      open
      onClose={onClose}
      title={`${MEAL_SLOT_LABELS[slot]} · ${formatDateRu(date)}`}
      description={slot === 'breakfast' ? 'Выбери шаблон или напиши своё.' : 'Без выбора остаётся «домашнее блюдо» — уточнишь по факту.'}
      footer={
        <div className="flex gap-2">
          {entry ? (
            <Button variant="ghost" disabled={busy} onClick={() => save(null, null)}>
              Очистить
            </Button>
          ) : null}
          <Button variant="primary" className="flex-1" loading={busy} disabled={!templateId && !text.trim()} onClick={() => save(templateId, templateId ? null : text.trim())}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {options.length ? (
          <div>
            <p className="mb-1.5 text-sm font-medium">Из шаблонов</p>
            <Chips
              ariaLabel="Шаблон блюда"
              options={options.map((t) => ({ value: t.id, label: t.title }))}
              value={templateId ? [templateId] : []}
              onChange={(v) => {
                const next = v[0] === templateId ? null : (v[0] ?? null);
                setTemplateId(next);
                if (next) setText('');
              }}
            />
          </div>
        ) : null}
        <Input
          label={options.length ? 'Или своё блюдо' : 'Блюдо'}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (e.target.value) setTemplateId(null);
          }}
          placeholder={PLACEHOLDER[slot]}
          maxLength={300}
        />
      </div>
    </Sheet>
  );
}

function WeekMenu({ weekStart, days, plan: entries, templates }: { weekStart: string; days: string[]; plan: PlanEntry[]; templates: MealTemplate[] }) {
  const plan = usePlan();
  const { today } = useClientUser();
  const [picked, setDay] = useState(today);
  const [edit, setEdit] = useState<{ date: string; slot: PlanSlot; n: number } | null>(null);
  const day = days.includes(picked) ? picked : days.includes(today) ? today : days[0]!;
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
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {days.map((d) => (
          <Card key={d} className={cn('min-w-0 p-2', d === today && 'border-accent', d !== day && 'hidden lg:block')}>
            <p className="px-2.5 pb-1 pt-1.5 text-sm font-semibold">
              {formatDateRu(d)}
              {d === today ? <span className="ml-2 text-xs font-normal text-accent">сегодня</span> : null}
            </p>
            <div className="divide-y divide-border">
              {(['breakfast', 'lunch', 'dinner'] as const).map((slot) => (
                <SlotRow key={slot} date={d} slot={slot} entry={get(d, slot)} onOpen={() => setEdit({ date: d, slot, n: (edit?.n ?? 0) + 1 })} />
              ))}
            </div>
          </Card>
        ))}
      </div>
      <SlotSheet
        key={edit ? `${edit.date}:${edit.slot}:${edit.n}` : 'closed'}
        target={edit ? { date: edit.date, slot: edit.slot, entry: get(edit.date, edit.slot) } : null}
        templates={templates}
        plan={plan}
        onClose={() => setEdit(null)}
      />
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
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-48 text-xs text-muted">
          {templates.some((t) => t.isExample) ? 'Готовые шаблоны — примеры для старта: их можно менять и выключать. ' : ''}
          Это не медицинское предписание — состав проверяй сам.
        </p>
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
                <li key={t.id} className="flex items-center gap-2 py-1 pl-3 pr-2">
                  <button type="button" onClick={() => openEdit(t)} className="min-h-11 min-w-0 flex-1 py-1 text-left">
                    <span className={cn('block text-[15px]', !t.enabled && 'text-muted')}>{t.title}</span>
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
