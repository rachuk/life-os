'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { formatDateRu } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';

export function AddEventSheet({ open, onClose, defaultDate }: { open: boolean; onClose: () => void; defaultDate: string }) {
  const router = useRouter();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(defaultDate);
  const [time, setTime] = useState('19:00');
  const [duration, setDuration] = useState(60);
  const [kind, setKind] = useState('custom');
  const [priorityClass, setPriorityClass] = useState('flexible');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ warnings: string[] }>('/api/plan/events', { body: { title, date, startTime: time, durationMinutes: duration, kind, priorityClass } });
      router.refresh();
      onClose();
      setTitle('');
      toast.ok(r.warnings.length ? `Добавлено. ${r.warnings.join(' ')}` : 'Добавлено в план');
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title="Новое событие"
      description="Пересечения покажу — решение за тобой."
      footer={
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Отмена
          </Button>
          <Button variant="primary" loading={busy} disabled={!title.trim()} onClick={save}>
            Добавить
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <Input label="Название" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Например, стоматолог" />
        <div className="grid grid-cols-2 gap-3">
          <Input type="date" label={date ? `День · ${formatDateRu(date)}` : 'День'} value={date} onChange={(e) => setDate(e.target.value)} />
          <Input type="time" label="Начало" value={time} onChange={(e) => setTime(e.target.value)} />
          <Input type="number" label="Длительность, мин" min={5} max={720} value={duration} onChange={(e) => setDuration(Number(e.target.value) || 30)} />
          <Select label="Тип" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="custom">Событие</option>
            <option value="task">Дело</option>
            <option value="own_project">Свой проект</option>
            <option value="workout">Тренировка</option>
            <option value="free_time">Свободное время</option>
          </Select>
        </div>
        <Select label="Можно ли двигать" value={priorityClass} onChange={(e) => setPriorityClass(e.target.value)}>
          <option value="flexible">Да, если что-то важнее</option>
          <option value="required_movable">Обязательно сделать, но время можно поменять</option>
          <option value="fixed">Нет — это встреча с точным временем</option>
        </Select>
      </div>
    </Sheet>
  );
}
