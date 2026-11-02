'use client';
import { CalendarClock, Check, Circle, Search } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { TASK_CATEGORY_LABELS, type TaskCategory } from '@/domain/types';
import { formatDateRu, formatTime, relativeDayLabel } from '@/domain/time';
import { api, errorMessage } from '@/lib/api';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Card } from '@/components/ui/Card';
import { cn } from '@/components/ui/cn';
import { Input } from '@/components/ui/Field';
import { Segmented } from '@/components/ui/Segmented';
import { EmptyState } from '@/components/ui/States';
import { useToast } from '@/components/ui/Toaster';
import { useClientUser } from '@/components/shell/UserContext';
import type { SerializedTask } from '@/server/services/tasks';
import { TaskSheet } from './TaskSheet';
import { openCapture } from '@/components/shell/events';

type Tab = 'inbox' | 'scheduled' | 'waiting' | 'someday' | 'done';
interface Project {
  id: string;
  name: string;
  openTasks: number;
}
interface Pending {
  id: string;
  rawText: string | null;
  createdAt: string;
}

export function TasksClient({
  tab,
  q,
  tasks,
  counts,
  projects,
  pendingInbox,
  today,
}: {
  tab: Tab;
  q: string;
  tasks: SerializedTask[];
  counts: Record<string, number>;
  projects: Project[];
  pendingInbox: Pending[];
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const { tz } = useClientUser();
  const [title, setTitle] = useState('');
  const [adding, setAdding] = useState(false);
  const [open, setOpen] = useState<SerializedTask | null>(null);
  const [search, setSearch] = useState(q);
  const [completing, setCompleting] = useState<string | null>(null);
  const [justDone, setJustDone] = useState<Set<string>>(new Set());
  const [projectName, setProjectName] = useState('');
  const [showProject, setShowProject] = useState(false);

  async function addProject(e: React.FormEvent) {
    e.preventDefault();
    if (!projectName.trim()) return;
    try {
      await api('/api/projects', { body: { name: projectName.trim(), category: 'own_project', status: 'active' } });
      setProjectName('');
      setShowProject(false);
      router.refresh();
      toast.ok('Проект создан — выбери его в карточке дела');
    } catch (err) {
      toast.error(errorMessage(err));
    }
  }

  const go = (t: Tab, query = search) => router.push(`/tasks?tab=${t}${query ? `&q=${encodeURIComponent(query)}` : ''}`);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) return;
    setAdding(true);
    try {
      const type = tab === 'someday' ? 'idea' : tab === 'waiting' ? 'waiting' : 'task';
      const r = await api<{ task: SerializedTask; note: string | null }>('/api/tasks', { body: { title: title.trim(), type, category: 'personal', priority: 'normal', parseDates: true } });
      setTitle('');
      router.refresh();
      toast.ok(r.task.dueDate ? `Добавлено на ${relativeDayLabel(r.task.dueDate, today).toLowerCase()}` : r.note ? `Добавлено. ${r.note}` : 'Добавлено во входящие');
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setAdding(false);
    }
  }

  async function toggleDone(t: SerializedTask) {
    setCompleting(t.id);
    try {
      if (t.status === 'done') {
        await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: 'todo' } });
        router.refresh();
      } else {
        const prev = t.status;
        await api(`/api/tasks/${t.id}/complete`, { body: {} });
        setJustDone((s) => new Set(s).add(t.id));
        // keep the struck-through row visible for a moment, then refresh the list
        setTimeout(() => router.refresh(), 2500);
        toast.ok('Готово', {
          label: 'Отменить',
          onClick: async () => {
            try {
              await api(`/api/tasks/${t.id}`, { method: 'PATCH', body: { status: prev === 'done' ? 'todo' : prev } });
              setJustDone((s) => {
                const n = new Set(s);
                n.delete(t.id);
                return n;
              });
              router.refresh();
            } catch (e) {
              toast.error(errorMessage(e));
            }
          },
        });
      }
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setCompleting(null);
    }
  }

  const c = (k: string) => counts[k] ?? 0;
  const groups = new Map<string, SerializedTask[]>();
  for (const t of tasks) {
    const project = projects.find((p) => p.id === t.projectId);
    const key = project ? `Проект: ${project.name}` : (TASK_CATEGORY_LABELS[t.category as TaskCategory] ?? 'Другое');
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
  }

  return (
    <div className="space-y-5">
      <header className="flex items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">Дела</h1>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go(tab, search);
          }}
          className="relative w-44 sm:w-64"
        >
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-faint" />
          <Input aria-label="Поиск" placeholder="Поиск" value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </form>
      </header>

      <Segmented
        ariaLabel="Списки дел"
        value={tab}
        onChange={(t) => go(t, '')}
        options={[
          { value: 'inbox', label: 'Входящие', count: c('inbox') },
          { value: 'scheduled', label: 'В плане', count: c('scheduled') },
          { value: 'waiting', label: 'Жду', count: c('waiting') },
          { value: 'someday', label: 'Потом', count: c('someday') },
          { value: 'done', label: 'Готово' },
        ]}
      />

      {tab === 'inbox' && pendingInbox.length ? (
        <Card className="p-4">
          <p className="text-sm font-medium">Ждут подтверждения ({pendingInbox.length})</p>
          <p className="text-xs text-muted">Сообщения из Telegram и быстрого ввода не создают дела, пока ты их не подтвердишь.</p>
          <ul className="mt-2 space-y-1">
            {pendingInbox.map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => openCapture(i.id)} className="min-h-11 w-full truncate rounded-xl px-2 text-left text-sm hover:bg-surface-2">
                  «{i.rawText?.slice(0, 90)}»
                </button>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {tab !== 'done' && tab !== 'scheduled' ? (
        <form onSubmit={add} className="flex gap-2">
          <Input
            aria-label="Новое дело"
            placeholder={tab === 'someday' ? 'Идея или желание…' : tab === 'waiting' ? 'Чего жду…' : 'Новое дело, можно «в пятницу»'}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <Button type="submit" variant="primary" loading={adding} disabled={!title.trim()}>
            Добавить
          </Button>
        </form>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {projects.map((p) => (
          <span key={p.id} className="rounded-full bg-surface-2 px-3 py-1 text-xs text-muted">
            {p.name} · {p.openTasks}
          </span>
        ))}
        {showProject ? (
          <form onSubmit={addProject} className="flex w-full gap-2 sm:w-auto">
            <Input aria-label="Название проекта" autoFocus placeholder="Например, выбрать страховку" value={projectName} onChange={(e) => setProjectName(e.target.value)} />
            <Button type="submit" size="sm" disabled={!projectName.trim()}>
              Создать
            </Button>
          </form>
        ) : (
          <Button size="sm" variant="ghost" onClick={() => setShowProject(true)}>
            + Проект
          </Button>
        )}
      </div>

      {tasks.length ? (
        [...groups.entries()].map(([group, list]) => (
          <section key={group} className="space-y-1.5">
            <h2 className="px-1 text-[13px] font-semibold uppercase tracking-wide text-muted">{group}</h2>
            <Card className="divide-y divide-border">
              {list.map((t) => {
                const done = t.status === 'done' || t.status === 'cancelled' || justDone.has(t.id);
                const overdue = !done && t.dueDate && t.dueDate < today;
                return (
                  <div key={t.id} className="flex items-start gap-1 pr-2">
                    <button
                      type="button"
                      onClick={() => toggleDone(t)}
                      disabled={completing === t.id}
                      aria-label={done ? `Вернуть «${t.title}» в работу` : `Отметить «${t.title}» выполненным`}
                      className="grid size-12 shrink-0 place-items-center text-muted hover:text-accent"
                    >
                      {done ? <Check className="size-5 text-ok" /> : <Circle className="size-5" />}
                    </button>
                    <button type="button" onClick={() => setOpen(t)} className="min-w-0 flex-1 py-3 text-left">
                      <span className={cn('block text-[15px]', done && 'text-muted line-through')}>{t.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
                        {t.dueDate ? (
                          <span className={cn(overdue && 'font-medium text-danger')}>
                            {overdue ? 'Просрочено: ' : 'Срок: '}
                            {relativeDayLabel(t.dueDate, today)}
                            {t.dueAt ? ` ${formatTime(t.dueAt, tz)}` : ''}
                          </span>
                        ) : null}
                        {t.plannedAt ? (
                          <span className="inline-flex items-center gap-1">
                            <CalendarClock className="size-3" /> {formatDateRu(t.plannedAt.slice(0, 10))} {formatTime(t.plannedAt, tz)}
                          </span>
                        ) : null}
                        {t.followUpAt ? <span>Проверить: {relativeDayLabel(t.followUpAt.slice(0, 10), today)}</span> : null}
                        {t.waitingFor ? <span>Жду: {t.waitingFor}</span> : null}
                        {t.nextAction ? <span>Дальше: {t.nextAction}</span> : null}
                        {t.type === 'reminder' ? <Badge>напоминание</Badge> : null}
                        {t.priority === 'high' ? <Badge tone="warn">важно</Badge> : null}
                      </span>
                    </button>
                  </div>
                );
              })}
            </Card>
          </section>
        ))
      ) : (
        <Card>
          <EmptyState
            title={
              q
                ? 'Ничего не найдено'
                : { inbox: 'Входящие пусты', scheduled: 'Нет дел со сроком', waiting: 'Ничего не ждёшь', someday: 'Идей пока нет', done: 'Пока ничего не завершено' }[tab]
            }
          >
            {q
              ? null
              : {
                  inbox: 'Выгрузи дела из головы через «+» — текстом или голосом.',
                  scheduled: 'Здесь появятся дела с датой и дела, поставленные в план.',
                  waiting: 'Отметь дело «Выполнено + проверить ответ» — оно появится здесь с датой проверки.',
                  someday: 'Записывай сюда желания и идеи без срока.',
                  done: 'Выполненные дела будут здесь.',
                }[tab]}
          </EmptyState>
        </Card>
      )}

      <TaskSheet task={open} projects={projects} onClose={() => setOpen(null)} today={today} />
    </div>
  );
}
