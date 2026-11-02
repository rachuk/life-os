import { requirePageUser } from '@/server/auth/current';
import { inUser, now } from '@/server/context';
import { listPendingInbox, serializeInboxItem } from '@/server/services/inbox';
import { listProjects, listTasks, serializeTask, taskCounts, type TaskTab } from '@/server/services/tasks';
import { localDateOf } from '@/domain/time';
import { TasksClient } from '@/components/tasks/TasksClient';

export const metadata = { title: 'Дела' };
const TABS: TaskTab[] = ['inbox', 'scheduled', 'waiting', 'someday', 'done'];

export default async function TasksPage({ searchParams }: { searchParams: Promise<{ tab?: string; q?: string }> }) {
  const user = await requirePageUser();
  const sp = await searchParams;
  const tab = (TABS.includes(sp.tab as TaskTab) ? sp.tab : 'inbox') as TaskTab;
  const data = await inUser(user.id, async (tx, ctx) => ({
    tasks: (await listTasks(tx, ctx, tab, sp.q ?? null)).map(serializeTask),
    counts: await taskCounts(tx, user.id),
    projects: await listProjects(tx, user.id),
    pendingInbox: (await listPendingInbox(tx, user.id, 10)).map(serializeInboxItem),
    today: localDateOf(now(), ctx.tz),
  }));
  return <TasksClient tab={tab as Exclude<TaskTab, 'all'>} q={sp.q ?? ''} {...data} />;
}
