import Link from 'next/link';
import { inUser, now } from '@/server/context';
import { listInApp } from '@/server/services/notifications';
import { listPendingInbox } from '@/server/services/inbox';
import { getTodayData } from '@/server/views/today';
import { formatRange, formatTime } from '@/domain/time';

/** Right-hand panel on wide screens: Сейчас / Входящие / Последние уведомления (PRD §3.2). */
export async function ContextPanel({ userId }: { userId: string }) {
  const data = await inUser(userId, async (tx, ctx) => ({
    today: await getTodayData(tx, ctx, now()),
    inbox: await listPendingInbox(tx, userId, 5),
    notifications: await listInApp(tx, userId, 5),
    tz: ctx.tz,
  }));
  const byId = new Map(data.today.events.map((e) => [e.id, e]));
  const next = data.today.now.nextIds.map((id) => byId.get(id)).filter(Boolean).slice(0, 4);
  return (
    <div className="space-y-6 text-sm">
      <section>
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Сейчас</h2>
        <p className="text-[15px] font-semibold">{data.today.now.headline}</p>
        {data.today.now.subline ? <p className="mt-0.5 text-muted">{data.today.now.subline}</p> : null}
        {next.length ? (
          <ul className="mt-3 space-y-1.5">
            {next.map((e) => (
              <li key={e!.id} className="flex justify-between gap-2">
                <span className="truncate">{e!.title}</span>
                <span className="tabular text-muted">{formatRange(e!.startAt, e!.endAt, data.tz)}</span>
              </li>
            ))}
          </ul>
        ) : null}
      </section>
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Входящие</h2>
          <Link href="/tasks" className="text-xs text-accent">
            Все
          </Link>
        </div>
        {data.inbox.length ? (
          <ul className="space-y-1.5">
            {data.inbox.map((i) => (
              <li key={i.id} className="truncate text-muted">
                {i.rawText}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Неразобранных сообщений нет.</p>
        )}
      </section>
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted">Уведомления</h2>
          <Link href="/notifications" className="text-xs text-accent">
            Все
          </Link>
        </div>
        {data.notifications.length ? (
          <ul className="space-y-2">
            {data.notifications.map((n) => (
              <li key={n.id}>
                <p className={n.readAt ? 'text-muted' : 'font-medium'}>{n.title}</p>
                <p className="text-xs text-faint">{n.sentAt ? formatTime(n.sentAt, data.tz) : ''}</p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">Пока не было.</p>
        )}
      </section>
    </div>
  );
}
