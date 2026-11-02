'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TASK_CATEGORY_LABELS, type TaskCategory } from '@/domain/types';
import { addDays, formatDateRu, formatTime } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Button } from '@/components/ui/Button';
import { Input, Select, Textarea } from '@/components/ui/Field';
import { Sheet } from '@/components/ui/Sheet';
import { Notice } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';
import type { SerializedTask } from '@/server/services/tasks';

type Props = { task: SerializedTask | null; projects: { id: string; name: string }[]; onClose: () => void; today: string };

export function TaskSheet(props: Props) {
  if (!props.task) return null;
  return <TaskSheetInner key={props.task.id + props.task.updatedAt} {...props} task={props.task} />;
}

function TaskSheetInner({ task, projects, onClose, today }: Props & { task: SerializedTask }) {
  const router = useRouter();
  const toast = useToast();
  const { tz } = useClientUser();
  const [f, setF] = useState<Record<string, string>>(() => ({
    title: task.title,
    details: task.details ?? '',
    category: task.category,
    type: task.type,
    priority: task.priority,
    dueDate: task.dueDate ?? '',
    dueTime: task.dueAt ? formatTime(task.dueAt, tz) : '',
    nextAction: task.nextAction ?? '',
    waitingFor: task.waitingFor ?? '',
    followUpDate: task.followUpAt ? task.followUpAt.slice(0, 10) : '',
    estimatedMinutes: task.estimatedMinutes ? String(task.estimatedMinutes) : '',
    projectId: task.projectId ?? '',
    status: task.status,
  }));
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [schedDate, setSchedDate] = useState(task.dueDate && task.dueDate >= today ? task.dueDate : today);
  const [schedTime, setSchedTime] = useState('');
  const [followDate, setFollowDate] = useState(addDays(today, 3));
  const [panel, setPanel] = useState<'plan' | 'follow' | null>(null);

  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));

  async function run(key: string, fn: () => Promise<unknown>, msg: string) {
    setBusy(key);
    setError(null);
    try {
      await fn();
      router.refresh();
      onClose();
      toast.ok(msg);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  }

  const save = () =>
    run(
      'save',
      () =>
        api(`/api/tasks/${task.id}`, {
          method: 'PATCH',
          body: {
            title: f.title,
            details: f.details || null,
            category: f.category,
            type: f.type,
            priority: f.priority,
            status: f.status,
            dueDate: f.dueDate || null,
            dueTime: f.dueDate && f.dueTime ? f.dueTime : null,
            nextAction: f.nextAction || null,
            waitingFor: f.waitingFor || null,
            followUpDate: f.followUpDate || null,
            estimatedMinutes: f.estimatedMinutes ? Number(f.estimatedMinutes) : null,
            projectId: f.projectId || null,
          },
        }),
      'Сохранено',
    );

  const quick = (key: string, status: string, msg: string) => run(key, () => api(`/api/tasks/${task.id}`, { method: 'PATCH', body: { status } }), msg);
  const CATEGORIES: TaskCategory[] = ['personal', 'health', 'finance', 'household', 'work_reminder', 'own_project'];

  return (
    <Sheet
      open
      onClose={onClose}
      title="Дело"
      size="lg"
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="ghost" loading={busy === 'delete'} onClick={() => run('delete', () => api(`/api/tasks/${task.id}`, { method: 'DELETE' }), 'Удалено')}>
            Удалить
          </Button>
          <Button variant="primary" loading={busy === 'save'} onClick={save}>
            Сохранить
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        {error ? <Notice tone="danger">{error}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          {task.status !== 'done' ? (
            <Button size="sm" variant="primary" loading={busy === 'q-done'} onClick={() => run('q-done', () => api(`/api/tasks/${task.id}/complete`, { body: {} }), 'Готово')}>
              Готово
            </Button>
          ) : (
            <Button size="sm" loading={busy === 'q-reopen'} onClick={() => quick('q-reopen', 'todo', 'Вернул в работу')}>
              Вернуть в работу
            </Button>
          )}
          <Button size="sm" variant={panel === 'plan' ? 'soft' : 'secondary'} onClick={() => setPanel(panel === 'plan' ? null : 'plan')}>
            В план
          </Button>
          <Button size="sm" variant={panel === 'follow' ? 'soft' : 'secondary'} onClick={() => setPanel(panel === 'follow' ? null : 'follow')}>
            Сделал, жду ответа
          </Button>
          {task.status !== 'someday' ? (
            <Button size="sm" variant="ghost" loading={busy === 'q-someday'} onClick={() => quick('q-someday', 'someday', 'Перенесено в «Потом»')}>
              Потом
            </Button>
          ) : null}
        </div>

        {panel === 'plan' ? (
          <div className="space-y-2 rounded-2xl border border-border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Input type="date" label={formatDateRu(schedDate)} value={schedDate} onChange={(e) => setSchedDate(e.target.value)} className="w-auto" />
              <Input type="time" label="Время" value={schedTime} onChange={(e) => setSchedTime(e.target.value)} className="w-auto" />
              <Button
                variant="primary"
                loading={busy === 'schedule'}
                onClick={() =>
                  run(
                    'schedule',
                    () => api(`/api/tasks/${task.id}/schedule`, { body: { date: schedDate, startTime: schedTime || null, durationMinutes: Number(f.estimatedMinutes) || 30 } }),
                    'Добавлено в план',
                  )
                }
              >
                Поставить
              </Button>
            </div>
            <p className="text-xs text-muted">Без времени — найду ближайшее свободное окно (в будни после работы).</p>
          </div>
        ) : null}

        {panel === 'follow' ? (
          <div className="space-y-2 rounded-2xl border border-border p-3">
            <div className="flex flex-wrap items-end gap-2">
              <Input type="date" label={`Проверить ответ · ${formatDateRu(followDate)}`} value={followDate} onChange={(e) => setFollowDate(e.target.value)} className="w-auto" />
              <Button
                variant="primary"
                loading={busy === 'follow'}
                onClick={() =>
                  run(
                    'follow',
                    () => api(`/api/tasks/${task.id}/complete`, { body: { followUp: { title: `Проверить ответ: ${task.title}`, date: followDate, waitingFor: f.waitingFor || null } } }),
                    'Готово. Проверка ответа — во вкладке «Жду»',
                  )
                }
              >
                Отметить
              </Button>
            </div>
          </div>
        ) : null}

        <Input label="Название" value={f.title ?? ''} onChange={set('title')} />
        <div className="grid grid-cols-2 gap-3">
          <Input type="date" label={f.dueDate ? `Срок · ${formatDateRu(f.dueDate)}` : 'Срок'} hint="пусто — без срока" value={f.dueDate ?? ''} onChange={set('dueDate')} />
          <Input type="time" label="Время" value={f.dueTime ?? ''} onChange={set('dueTime')} disabled={!f.dueDate} />
        </div>

        <details className="rounded-2xl border border-border px-3">
          <summary className="flex min-h-11 cursor-pointer list-none items-center text-sm text-accent">Подробнее</summary>
          <div className="space-y-3 pb-3">
            <div className="grid grid-cols-2 gap-3">
              <Select label="Тип" value={f.type} onChange={set('type')}>
                <option value="task">Задача</option>
                <option value="reminder">Напоминание</option>
                <option value="waiting">Ожидание ответа</option>
                <option value="idea">Идея</option>
                <option value="wish">Желание</option>
              </Select>
              <Select label="Область" value={CATEGORIES.includes(f.category as TaskCategory) ? f.category : 'personal'} onChange={set('category')}>
                {CATEGORIES.map((k) => (
                  <option key={k} value={k}>
                    {TASK_CATEGORY_LABELS[k]}
                  </option>
                ))}
              </Select>
              <Select label="Статус" value={['scheduled', 'in_progress'].includes(f.status ?? '') ? 'todo' : f.status} onChange={set('status')}>
                <option value="inbox">Входящие</option>
                <option value="todo">К выполнению</option>
                <option value="waiting">Жду ответа</option>
                <option value="someday">Потом</option>
                <option value="done">Готово</option>
                <option value="cancelled">Отменено</option>
              </Select>
              <Select label="Важность" value={f.priority} onChange={set('priority')}>
                <option value="low">Низкая</option>
                <option value="normal">Обычная</option>
                <option value="high">Важно</option>
              </Select>
              <Input label="Следующий шаг" value={f.nextAction ?? ''} onChange={set('nextAction')} />
              <Input type="number" label="Оценка, мин" value={f.estimatedMinutes ?? ''} onChange={set('estimatedMinutes')} />
              {f.type === 'waiting' || f.status === 'waiting' ? (
                <>
                  <Input label="Жду от" value={f.waitingFor ?? ''} onChange={set('waitingFor')} />
                  <Input type="date" label="Проверить ответ" value={f.followUpDate ?? ''} onChange={set('followUpDate')} />
                </>
              ) : null}
              <Select label="Проект" value={f.projectId} onChange={set('projectId')}>
                <option value="">Без проекта</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </div>
            <Textarea label="Заметки" value={f.details ?? ''} onChange={set('details')} rows={3} />
            {task.category === 'work_reminder' ? <p className="text-xs text-muted">Рабочее напоминание: без названий клиентов и секретных деталей.</p> : null}
          </div>
        </details>
      </div>
    </Sheet>
  );
}
