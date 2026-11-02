'use client';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';

export interface MealTemplate {
  id: string;
  title: string;
  category: string;
  ingredientsJson: { name: string; quantity: number | null; unit: string | null }[];
  prepMinutes: number | null;
  notes: string | null;
  isExample: boolean;
  enabled: boolean;
}

export const CATEGORY_LABELS: Record<string, string> = {
  breakfast: 'Завтрак',
  snack: 'Перекус',
  lunch: 'Обед',
  dinner: 'Ужин',
  drink: 'Напиток',
  post_workout: 'После тренировки',
};

const UNITS = ['', 'г', 'кг', 'мл', 'л', 'шт', 'уп', 'бут'];

interface Row {
  name: string;
  quantity: string;
  unit: string;
}

/** Create / edit a meal template with ingredients. No calories, no medical claims (PRD §8.3). */
export function TemplateSheet({ open, onClose, template }: { open: boolean; onClose: () => void; template: MealTemplate | null }) {
  const router = useRouter();
  const toast = useToast();
  // state is initialised on mount; the parent remounts the sheet (key) for each template it opens
  const [title, setTitle] = useState(template?.title ?? '');
  const [category, setCategory] = useState(template?.category ?? 'breakfast');
  const [prep, setPrep] = useState(template?.prepMinutes != null ? String(template.prepMinutes) : '');
  const [notes, setNotes] = useState(template?.notes ?? '');
  const [rows, setRows] = useState<Row[]>(() =>
    template?.ingredientsJson.length
      ? template.ingredientsJson.map((i) => ({ name: i.name, quantity: i.quantity != null ? String(i.quantity).replace('.', ',') : '', unit: i.unit ?? '' }))
      : [{ name: '', quantity: '', unit: '' }],
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function save() {
    setError(null);
    const ingredients = rows
      .filter((r) => r.name.trim())
      .map((r) => {
        const q = r.quantity.trim() ? Number(r.quantity.replace(',', '.').replace(/\s/g, '')) : null;
        return { name: r.name.trim(), quantity: q !== null && Number.isFinite(q) && q > 0 ? q : null, unit: r.unit || null };
      });
    const prepMinutes = prep.trim() ? Number(prep) : null;
    if (!title.trim()) return setError('Напиши название блюда');
    if (prepMinutes !== null && (!Number.isInteger(prepMinutes) || prepMinutes < 0 || prepMinutes > 300)) return setError('Время готовки — минуты от 0 до 300');
    const body = { title: title.trim(), category, ingredients, prepMinutes, notes: notes.trim() || null };
    setBusy('save');
    try {
      if (template) await api(`/api/meals/templates/${template.id}`, { method: 'PATCH', body });
      else await api('/api/meals/templates', { body: { ...body, enabled: true } });
      toast.ok(template ? 'Шаблон сохранён' : 'Шаблон добавлен');
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!template) return;
    setBusy('delete');
    try {
      await api(`/api/meals/templates/${template.id}`, { method: 'DELETE' });
      toast.ok('Шаблон удалён');
      router.refresh();
      onClose();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const setRow = (i: number, patch: Partial<Row>) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  return (
    <Sheet
      open={open}
      onClose={onClose}
      size="lg"
      title={template ? 'Шаблон блюда' : 'Новый шаблон'}
      description={template?.isExample ? 'Это пример из каталога. После правки он станет твоим.' : 'Состав нужен для списка покупок. Калории не считаем.'}
      footer={
        <div className="flex flex-wrap gap-2">
          {template ? (
            confirmDelete ? (
              <Button variant="danger" loading={busy === 'delete'} onClick={remove}>
                Точно удалить
              </Button>
            ) : (
              <Button variant="ghost" icon={<Trash2 className="size-4" />} onClick={() => setConfirmDelete(true)}>
                Удалить
              </Button>
            )
          ) : null}
          <Button variant="primary" className="flex-1" loading={busy === 'save'} onClick={save}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Input label="Название" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} placeholder="например, Сырники со сметаной" />
        <div className="grid grid-cols-2 gap-3">
          <Select label="Приём пищи" value={category} onChange={(e) => setCategory(e.target.value)}>
            {Object.entries(CATEGORY_LABELS).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </Select>
          <Input label="Готовка, мин" inputMode="numeric" value={prep} onChange={(e) => setPrep(e.target.value)} placeholder="необязательно" />
        </div>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-sm font-medium">Ингредиенты</legend>
          {rows.map((r, i) => (
            <div key={i} className="flex gap-2">
              <Input aria-label={`Ингредиент ${i + 1}`} placeholder="продукт" value={r.name} onChange={(e) => setRow(i, { name: e.target.value })} className="min-w-0 flex-1" />
              <div className="w-[4.5rem] shrink-0">
                <Input aria-label={`Количество ${i + 1}`} placeholder="кол-во" inputMode="decimal" value={r.quantity} onChange={(e) => setRow(i, { quantity: e.target.value })} />
              </div>
              <div className="w-[4.5rem] shrink-0">
                <Select aria-label={`Единица ${i + 1}`} value={r.unit} onChange={(e) => setRow(i, { unit: e.target.value })}>
                  {UNITS.map((u) => (
                    <option key={u} value={u}>
                      {u || '—'}
                    </option>
                  ))}
                </Select>
              </div>
              <button type="button" aria-label="Убрать ингредиент" onClick={() => setRows((rs) => rs.filter((_, j) => j !== i))} className="grid size-11 shrink-0 place-items-center rounded-xl text-muted hover:bg-surface-2">
                <Trash2 className="size-4" />
              </button>
            </div>
          ))}
          <Button variant="ghost" icon={<Plus className="size-4" />} onClick={() => setRows((rs) => [...rs, { name: '', quantity: '', unit: '' }])} disabled={rows.length >= 30}>
            Ингредиент
          </Button>
        </fieldset>
        <Textarea label="Заметки" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={1000} placeholder="замены, как готовить — по желанию" />
      </div>
    </Sheet>
  );
}
