'use client';
import { Check, ChevronLeft, ChevronRight, ClipboardCopy, Minus, Plus, Trash2, Wand2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { SHOPPING_CATEGORY_LABELS, formatItem } from '@/domain/shopping/normalize';
import { addDays, formatDateShortRu } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { Sheet } from '@/components/ui/Sheet';
import { EmptyState, Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { cn } from '@/components/ui/cn';

export interface ShopItem {
  id: string;
  name: string;
  quantity: number | null;
  unit: string | null;
  category: string;
  checked: boolean;
  source: string;
  notes: string | null;
}

export interface ShopList {
  listType: 'personal' | 'household';
  id: string | null;
  name: string;
  items: ShopItem[];
  text: string;
  open: number;
  bought: number;
}

export interface MenuTemplate {
  id: string;
  title: string;
  category: string;
  planned: number;
}

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

const UNITS = ['', 'г', 'кг', 'мл', 'л', 'шт', 'уп', 'бут'];
const CATEGORY_ORDER = Object.keys(SHOPPING_CATEGORY_LABELS);
const TEMPLATE_GROUPS: Record<string, string> = { breakfast: 'Завтраки', snack: 'Перекусы', drink: 'Напитки', post_workout: 'После тренировки', lunch: 'Обеды', dinner: 'Ужины' };

function ItemRow({ item, onToggle, onEdit, busy }: { item: ShopItem; onToggle: () => void; onEdit: () => void; busy: boolean }) {
  return (
    <li className="flex items-center gap-1">
      <button
        type="button"
        role="checkbox"
        aria-checked={item.checked}
        aria-label={`${item.checked ? 'Снять отметку' : 'Отметить купленным'}: ${item.name}`}
        disabled={busy}
        onClick={onToggle}
        className="grid size-11 shrink-0 place-items-center rounded-xl hover:bg-surface-2 disabled:opacity-50"
      >
        <span className={cn('grid size-6 place-items-center rounded-md border-2', item.checked ? 'border-accent bg-accent text-accent-fg' : 'border-border')}>
          {item.checked ? <Check className="size-4" /> : null}
        </span>
      </button>
      <button type="button" onClick={onEdit} className="min-h-11 min-w-0 flex-1 rounded-xl px-2 py-1.5 text-left hover:bg-surface-2">
        <span className={cn('block text-[15px]', item.checked && 'text-muted line-through decoration-faint')}>
          {item.name}
          {item.quantity !== null ? <span className="tabular whitespace-nowrap text-muted"> · {item.quantity}{item.unit ? ` ${item.unit}` : ''}</span> : null}
        </span>
        {item.notes && !item.checked ? <span className="block text-xs text-muted">{item.notes}</span> : null}
      </button>
      {item.source === 'meal_template' && !item.checked ? <Badge className="mr-1 shrink-0">из меню</Badge> : null}
    </li>
  );
}

function Basket({ list, weekStart }: { list: ShopList; weekStart: string }) {
  const router = useRouter();
  const toast = useToast();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ tone: 'warn' | 'accent'; text: string } | null>(null);
  const [edit, setEdit] = useState<ShopItem | null>(null);
  const [showBought, setShowBought] = useState(false);
  const [showText, setShowText] = useState(false);
  const open = list.items.filter((i) => !i.checked);
  const bought = list.items.filter((i) => i.checked);
  const groups = CATEGORY_ORDER.map((c) => ({ c, items: open.filter((i) => (SHOPPING_CATEGORY_LABELS[i.category] ? i.category : 'other') === c) })).filter((g) => g.items.length);

  async function add(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy('add');
    setNotice(null);
    try {
      const r = await api<{ outcome: 'inserted' | 'merged' | 'duplicate'; message: string; item: ShopItem }>('/api/shopping', {
        body: { text: text.trim(), listType: list.listType, weekStart },
      });
      setText('');
      if (r.outcome === 'duplicate') setNotice({ tone: 'warn', text: `«${r.item.name}»: ${r.message.toLowerCase()} — повторно не добавляли.` });
      else if (r.outcome === 'merged') setNotice({ tone: 'accent', text: `«${r.item.name}»: количество добавлено к существующей строке, теперь ${formatItem(r.item).split(' — ')[1] ?? ''}.` });
      else toast.ok(`Добавлено: ${formatItem(r.item)}`);
      router.refresh();
    } catch (err) {
      setNotice({ tone: 'warn', text: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  }

  async function toggle(item: ShopItem) {
    setBusy(item.id);
    try {
      await api(`/api/shopping/items/${item.id}/check`, { body: { checked: !item.checked } });
      router.refresh();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(list.text);
      toast.ok('Список скопирован');
    } catch {
      toast.error('Не удалось скопировать — выдели текст вручную');
      setShowText(true);
    }
  }

  return (
    <Card className="p-3">
      <div className="mb-2 flex items-center justify-between gap-2 px-1">
        <h2 className="font-semibold">{list.name}</h2>
        <span className="tabular text-xs text-muted">
          {list.open ? `купить: ${list.open}` : list.bought ? 'всё куплено' : 'пусто'}
          {list.bought ? ` · куплено: ${list.bought}` : ''}
        </span>
      </div>
      <form onSubmit={add} className="flex gap-2">
        <Input aria-label={`Добавить в «${list.name}»`} placeholder="например, молоко 2 л" value={text} onChange={(e) => setText(e.target.value)} maxLength={200} className="min-w-0 flex-1" />
        <Button type="submit" variant="soft" loading={busy === 'add'} disabled={!text.trim()} aria-label="Добавить">
          <Plus className="size-5" />
        </Button>
      </form>
      {notice ? (
        <Notice tone={notice.tone} className="mt-2">
          {notice.text}
        </Notice>
      ) : null}

      {open.length ? (
        <div className="mt-3 space-y-3">
          {groups.map((g) => (
            <div key={g.c}>
              <p className="px-1 text-xs font-semibold uppercase tracking-wide text-muted">{SHOPPING_CATEGORY_LABELS[g.c]}</p>
              <ul>
                {g.items.map((i) => (
                  <ItemRow key={i.id} item={i} busy={busy === i.id} onToggle={() => toggle(i)} onEdit={() => setEdit(i)} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title={bought.length ? 'Всё из списка куплено' : 'Список пуст'} className="py-6">
          {bought.length ? 'Новые покупки можно добавить выше.' : 'Добавь продукты выше или собери список из меню недели.'}
        </EmptyState>
      )}

      {bought.length ? (
        <div className="mt-2 border-t border-border pt-1">
          <button type="button" onClick={() => setShowBought((v) => !v)} aria-expanded={showBought} className="flex min-h-11 w-full items-center justify-between px-1 text-sm text-muted">
            Куплено ({bought.length}) <span className="text-accent">{showBought ? 'Скрыть' : 'Показать'}</span>
          </button>
          {showBought ? (
            <ul>
              {bought.map((i) => (
                <ItemRow key={i.id} item={i} busy={busy === i.id} onToggle={() => toggle(i)} onEdit={() => setEdit(i)} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {list.items.length ? (
        <div className="mt-2 flex flex-wrap gap-2">
          <Button variant="secondary" icon={<ClipboardCopy className="size-4" />} onClick={copy} disabled={!open.length}>
            Скопировать списком
          </Button>
        </div>
      ) : null}
      {showText ? <Textarea aria-label="Текст списка" readOnly value={list.text} className="mt-2 min-h-40 text-sm" onFocus={(e) => e.currentTarget.select()} /> : null}

      <ItemSheet key={edit?.id ?? 'none'} item={edit} onClose={() => setEdit(null)} />
    </Card>
  );
}

function ItemSheet({ item, onClose }: { item: ShopItem | null; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  // initialised on mount; the parent remounts the sheet (key) for every item it opens
  const [name, setName] = useState(item?.name ?? '');
  const [qty, setQty] = useState(item?.quantity != null ? String(item.quantity) : '');
  const [unit, setUnit] = useState(item?.unit ?? '');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    if (!item) return;
    const q = qty.trim() ? Number(qty.replace(',', '.')) : null;
    if (q !== null && (!Number.isFinite(q) || q <= 0)) return setError('Количество — положительное число');
    if (!name.trim()) return setError('Название не может быть пустым');
    setBusy('save');
    try {
      await api(`/api/shopping/items/${item.id}`, { method: 'PATCH', body: { name: name.trim(), quantity: q, unit: unit || null } });
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }
  async function remove() {
    if (!item) return;
    setBusy('delete');
    try {
      await api(`/api/shopping/items/${item.id}`, { method: 'DELETE' });
      toast.ok('Удалено');
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Sheet
      open={!!item}
      onClose={onClose}
      title="Покупка"
      description={item?.source === 'meal_template' ? 'Строка из меню. После правки она станет твоей и не изменится при пересборке.' : undefined}
      footer={
        <div className="flex gap-2">
          <Button variant="danger" icon={<Trash2 className="size-4" />} loading={busy === 'delete'} onClick={remove}>
            Удалить
          </Button>
          <Button variant="primary" className="flex-1" loading={busy === 'save'} onClick={save}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="space-y-3">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Input label="Что купить" value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        <div className="grid grid-cols-2 gap-3">
          <Input label="Количество" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} placeholder="необязательно" />
          <Select label="Единица" value={unit} onChange={(e) => setUnit(e.target.value)}>
            {UNITS.map((u) => (
              <option key={u} value={u}>
                {u || '—'}
              </option>
            ))}
          </Select>
        </div>
        {item?.notes ? <p className="text-sm text-muted">{item.notes}</p> : null}
      </div>
    </Sheet>
  );
}

function GenerateSheet({ open, onClose, templates, weekStart }: { open: boolean; onClose: () => void; templates: MenuTemplate[]; weekStart: string }) {
  const router = useRouter();
  const toast = useToast();
  // initialised on mount; the parent remounts the sheet (key) each time it opens, so a refresh of the
  // server data while it is open does not wipe the user's numbers or the result
  const [times, setTimes] = useState<Record<string, number>>(() => Object.fromEntries(templates.map((t) => [t.id, t.planned])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; messages: string[] } | null>(null);

  const groups = Object.keys(TEMPLATE_GROUPS)
    .map((c) => ({ c, items: templates.filter((t) => t.category === c) }))
    .filter((g) => g.items.length);
  const total = Object.values(times).reduce((s, n) => s + n, 0);

  async function run() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ text: string; messages: string[] }>('/api/shopping/generate', {
        body: { weekStart, picks: Object.entries(times).map(([templateId, n]) => ({ templateId, times: n })) },
      });
      router.refresh();
      if (r.messages.length) setResult(r);
      else {
        toast.ok(r.text);
        onClose();
      }
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const set = (id: string, n: number) => setTimes((t) => ({ ...t, [id]: Math.max(0, Math.min(21, n)) }));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Собрать из меню"
      description="Сколько раз за неделю будет блюдо. Часть меню в списке пересчитывается целиком — повтор не дублирует. Ручные строки не трогаем."
      footer={
        result ? (
          <Button variant="primary" block onClick={onClose}>
            Готово
          </Button>
        ) : (
          <Button variant="primary" block loading={busy} onClick={run}>
            {total ? `Собрать (${total} ${plural(total, 'приём', 'приёма', 'приёмов')})` : 'Убрать строки меню из списка'}
          </Button>
        )
      }
    >
      {result ? (
        <div className="space-y-2">
          <Notice tone="ok">{result.text}</Notice>
          <ul className="space-y-1.5 text-sm">
            {result.messages.map((m) => (
              <li key={m} className="rounded-xl bg-surface-2 px-3 py-2">
                {m}
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <div className="space-y-4">
          {error ? <Notice tone="danger">{error}</Notice> : null}
          {groups.length ? (
            groups.map((g) => (
              <div key={g.c}>
                <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted">{TEMPLATE_GROUPS[g.c]}</p>
                <ul className="divide-y divide-border">
                  {g.items.map((t) => (
                    <li key={t.id} className="flex items-center justify-between gap-2 py-1">
                      <span className="min-w-0 text-[15px]">
                        {t.title}
                        {t.planned ? <span className="block text-xs text-muted">в меню недели: {t.planned}</span> : null}
                      </span>
                      <span className="flex shrink-0 items-center gap-1">
                        <button type="button" aria-label={`Меньше: ${t.title}`} onClick={() => set(t.id, (times[t.id] ?? 0) - 1)} className="grid size-11 place-items-center rounded-xl border border-border hover:bg-surface-2">
                          <Minus className="size-4" />
                        </button>
                        <span className="tabular w-7 text-center font-medium" aria-live="polite">
                          {times[t.id] ?? 0}
                        </span>
                        <button type="button" aria-label={`Больше: ${t.title}`} onClick={() => set(t.id, (times[t.id] ?? 0) + 1)} className="grid size-11 place-items-center rounded-xl border border-border hover:bg-surface-2">
                          <Plus className="size-4" />
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <EmptyState title="Нет включённых шаблонов">
              <Link href="/health/meals" className="text-accent">
                Добавь шаблоны блюд
              </Link>{' '}
              — из их состава соберётся список.
            </EmptyState>
          )}
        </div>
      )}
    </Sheet>
  );
}

export function ShoppingClient({ weekStart, lists, templates, currentWeek }: { weekStart: string; lists: ShopList[]; templates: MenuTemplate[]; currentWeek: string }) {
  const [tab, setTab] = useState<'personal' | 'household'>('personal');
  const [gen, setGen] = useState(false);
  const [genKey, setGenKey] = useState(0);
  const label = (l: ShopList) => (l.listType === 'personal' ? 'Личная' : 'Общая домашняя');

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2">
        <Link href={`/shopping?week=${addDays(weekStart, -7)}`} aria-label="Предыдущая неделя" className="grid size-11 place-items-center rounded-xl border border-border bg-surface hover:bg-surface-2">
          <ChevronLeft className="size-5" />
        </Link>
        <div className="text-center">
          <p className="text-sm font-medium">
            {formatDateShortRu(weekStart)} – {formatDateShortRu(addDays(weekStart, 6))}
          </p>
          {weekStart === currentWeek ? (
            <p className="text-xs text-accent">эта неделя</p>
          ) : (
            <Link href="/shopping" className="text-xs text-accent">
              к текущей неделе
            </Link>
          )}
        </div>
        <Link href={`/shopping?week=${addDays(weekStart, 7)}`} aria-label="Следующая неделя" className="grid size-11 place-items-center rounded-xl border border-border bg-surface hover:bg-surface-2">
          <ChevronRight className="size-5" />
        </Link>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="soft"
          icon={<Wand2 className="size-4" />}
          onClick={() => {
            setGenKey((k) => k + 1);
            setGen(true);
          }}
        >
          Собрать из меню
        </Button>
        <p className="text-xs text-muted">Запасы не отслеживаются — перед походом проверь дома. Ничего не заказывается автоматически.</p>
      </div>

      <Segmented
        ariaLabel="Корзина"
        className="lg:hidden"
        value={tab}
        onChange={setTab}
        options={lists.map((l) => ({ value: l.listType, label: label(l), count: l.open }))}
      />
      <div className="grid gap-4 lg:grid-cols-2">
        {lists.map((l) => (
          <div key={l.listType} className={cn(l.listType !== tab && 'hidden lg:block')}>
            <Basket list={l} weekStart={weekStart} />
          </div>
        ))}
      </div>
      <GenerateSheet key={genKey} open={gen} onClose={() => setGen(false)} templates={templates} weekStart={weekStart} />
    </div>
  );
}
