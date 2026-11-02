import { DateTime } from 'luxon';
import {
  effectiveSpec,
  inQuietHours,
  messageKey,
  reminderMessage,
  remindersForEvent,
  repeatKey,
  type Channel,
  type ReminderMessage,
} from '@/domain/notifications/reminders';
import { continuedByExtraWork } from '@/domain/planner/now';
import type { ReminderSpec } from '@/domain/planner/prefs';
import { isRemindable, type EventKind, type EventStatus } from '@/domain/types';
import { localDateOf } from '@/domain/time';
import type { Tx } from '../db';
import { withSystem, withUser } from '../db';
import { env } from '../env';
import { loadContext, type UserContext } from './profile';

/**
 * Reminder outbox (PRD §12.4). Rows are keyed by message_key = user|event|type|scheduled_at|channel,
 * so reconciliation is idempotent. Repeats use a time-less key → at most one repeat (NT-02).
 * An answer in any client acknowledges/cancels the event's rows in every channel (NT-03).
 */

export async function enabledChannels(tx: Tx, ctx: UserContext): Promise<Channel[]> {
  const e = env();
  const prefs = ctx.prefs.notifications.channels;
  const out: Channel[] = ['in_app'];
  const [tg] = await tx<{ n: number }[]>`
    select count(*)::int as n from telegram_connections
    where user_id = ${ctx.userId} and is_active and notification_enabled`;
  const telegramActive = !!e.ENABLE_TELEGRAM && !!e.TELEGRAM_BOT_TOKEN && (tg?.n ?? 0) > 0 && prefs.telegram;
  if (telegramActive) out.push('telegram');
  const [ps] = await tx<{ n: number }[]>`
    select count(*)::int as n from push_subscriptions where user_id = ${ctx.userId} and disabled_at is null`;
  const pushReady = !!e.ENABLE_WEB_PUSH && !!e.VAPID_PUBLIC_KEY && !!e.VAPID_PRIVATE_KEY && (ps?.n ?? 0) > 0 && prefs.web_push;
  // avoid double pings: web push is used when Telegram is not active
  if (pushReady && !telegramActive) out.push('web_push');
  return out;
}

interface ReminderEventRow {
  id: string;
  kind: EventKind;
  title: string;
  status: EventStatus;
  startAt: Date;
  endAt: Date;
  templateReminder: ReminderSpec | null;
}

export async function reconcileReminders(
  tx: Tx,
  ctx: UserContext,
  now: DateTime,
  opts: { eventIds?: string[]; horizonHours?: number } = {},
): Promise<{ inserted: number; cancelled: number }> {
  const horizon = now.plus({ hours: opts.horizonHours ?? 36 });
  const channels = await enabledChannels(tx, ctx);
  const events = opts.eventIds?.length
    ? await tx<ReminderEventRow[]>`
        select e.id, e.kind, e.title, e.status, e.start_at, e.end_at, t.reminder as template_reminder
        from schedule_events e left join schedule_templates t on t.id = e.template_id
        where e.user_id = ${ctx.userId} and e.id = any(${opts.eventIds})`
    : await tx<ReminderEventRow[]>`
        select e.id, e.kind, e.title, e.status, e.start_at, e.end_at, t.reminder as template_reminder
        from schedule_events e left join schedule_templates t on t.id = e.template_id
        where e.user_id = ${ctx.userId} and e.start_at < ${horizon.toJSDate()} and e.end_at > ${now.minus({ hours: 2 }).toJSDate()}`;

  // a work block followed directly by extra work gets no separate "Завершил работу?" (and no repeat)
  const extras = events.some((e) => e.kind === 'work')
    ? (
        await tx<{ kind: string; status: string; startAt: Date; endAt: Date }[]>`
          select kind, status, start_at, end_at from schedule_events
          where user_id = ${ctx.userId} and kind = 'extra_work' and status not in ('cancelled', 'skipped')
            and end_at > ${now.minus({ hours: 12 }).toJSDate()} and start_at < ${horizon.plus({ hours: 12 }).toJSDate()}`
      ).map((x) => ({ ...x, startAt: DateTime.fromJSDate(x.startAt, { zone: 'utc' }), endAt: DateTime.fromJSDate(x.endAt, { zone: 'utc' }) }))
    : [];
  const continued = new Set(
    events
      .filter(
        (e) =>
          e.kind === 'work' &&
          continuedByExtraWork({ startAt: DateTime.fromJSDate(e.startAt, { zone: 'utc' }), endAt: DateTime.fromJSDate(e.endAt, { zone: 'utc' }) }, extras),
      )
      .map((e) => e.id),
  );
  const remindable = (e: ReminderEventRow) => isRemindable(e.kind, e.status) && !continued.has(e.id);

  const desired = new Map<string, { eventId: string; channel: Channel; type: string; kind: string; at: DateTime; title: string }>();
  const keep = new Set<string>();
  for (const ev of events) {
    if (!remindable(ev)) continue;
    const spec = effectiveSpec(ev.kind, ev.templateReminder);
    const planned = remindersForEvent(
      {
        id: ev.id,
        kind: ev.kind,
        title: ev.title,
        startAt: DateTime.fromJSDate(ev.startAt, { zone: 'utc' }),
        endAt: DateTime.fromJSDate(ev.endAt, { zone: 'utc' }),
      },
      spec,
    );
    for (const r of planned) {
      if (r.scheduledAt > horizon) continue;
      if (r.kind !== 'review' && inQuietHours(r.scheduledAt, ctx.tz, ctx.profile.quietHours)) continue;
      for (const ch of channels) {
        const key = messageKey({ userId: ctx.userId, eventId: ev.id, reminderType: r.reminderType, scheduledAt: r.scheduledAt, channel: ch });
        // still part of the plan: a due row waiting for a retry (or for the worker after a restart) is kept
        keep.add(key);
        // only reminders that are not in the past are (re)created
        if (r.scheduledAt >= now.minus({ minutes: 1 })) {
          desired.set(key, { eventId: ev.id, channel: ch, type: r.reminderType, kind: r.kind, at: r.scheduledAt, title: ev.title });
        }
      }
    }
  }

  const eventIds = events.map((e) => e.id);
  let cancelled = 0;
  if (eventIds.length) {
    const existing = await tx<{ id: string; messageKey: string; reminderType: string; payloadJson: { baseKey?: string } }[]>`
      select id, message_key, reminder_type, payload_json from notification_outbox
      where user_id = ${ctx.userId} and status = 'scheduled' and event_id = any(${eventIds})`;
    const stale = existing.filter((r) =>
      r.reminderType === 'repeat' ? !r.payloadJson?.baseKey || !events.some((e) => remindable(e) && r.payloadJson.baseKey!.includes(e.id)) : !keep.has(r.messageKey),
    );
    if (stale.length) {
      await tx`update notification_outbox set status = 'cancelled', cancel_reason = 'plan_changed'
               where id = any(${stale.map((s) => s.id)})`;
      cancelled = stale.length;
    }
  }

  let inserted = 0;
  for (const [key, d] of desired) {
    const rows = await tx`
      insert into notification_outbox (user_id, event_id, channel, kind, reminder_type, message_key, scheduled_at, payload_json)
      values (${ctx.userId}, ${d.eventId}, ${d.channel}, ${d.kind}, ${d.type}, ${key}, ${d.at.toJSDate()},
              ${tx.json({ title: d.title } as never)})
      on conflict (message_key) do nothing returning id`;
    inserted += rows.length;
  }
  return { inserted, cancelled };
}

/** A scheduled repeat stays valid only while its event is still remindable. */
export async function acknowledgeEventNotifications(tx: Tx, userId: string, eventId: string, action: string): Promise<void> {
  await tx`update notification_outbox set status = 'acknowledged', acknowledged_at = now()
           where user_id = ${userId} and event_id = ${eventId} and status in ('sent', 'delivered_unknown')`;
  // «Начал» does not answer «Закончил?»: the end-of-block question stays scheduled
  await tx`update notification_outbox set status = 'cancelled', cancel_reason = ${`answered:${action}`}
           where user_id = ${userId} and event_id = ${eventId} and status = 'scheduled'
             and not (${action} = 'start' and reminder_type = 'end')`;
}

// ---------------------------------------------------------------------------
// In-app inbox
// ---------------------------------------------------------------------------
export interface InAppNotification {
  id: string;
  eventId: string | null;
  title: string;
  body: string;
  path: string;
  status: string;
  sentAt: string | null;
  readAt: string | null;
  kind: string;
  buttons: ReminderMessage['buttons'];
}

export async function listInApp(tx: Tx, userId: string, limit = 30): Promise<InAppNotification[]> {
  const rows = await tx<{ id: string; eventId: string | null; payloadJson: Partial<ReminderMessage>; status: string; sentAt: Date | null; readAt: Date | null; kind: string }[]>`
    select id, event_id, payload_json, status, sent_at, read_at, kind from notification_outbox
    where user_id = ${userId} and channel = 'in_app' and status in ('sent', 'acknowledged')
    order by sent_at desc nulls last limit ${limit}`;
  return rows.map((r) => ({
    id: r.id,
    eventId: r.eventId,
    title: r.payloadJson.title ?? 'Напоминание',
    body: r.payloadJson.body ?? '',
    path: r.payloadJson.path ?? '/today',
    buttons: r.payloadJson.buttons ?? [],
    status: r.status,
    sentAt: r.sentAt?.toISOString() ?? null,
    readAt: r.readAt?.toISOString() ?? null,
    kind: r.kind,
  }));
}

export async function unreadCount(tx: Tx, userId: string): Promise<number> {
  const [r] = await tx<{ n: number }[]>`
    select count(*)::int as n from notification_outbox
    where user_id = ${userId} and channel = 'in_app' and status = 'sent' and read_at is null`;
  return r?.n ?? 0;
}

export async function markRead(tx: Tx, userId: string, ids: string[] | 'all'): Promise<void> {
  if (ids === 'all') {
    await tx`update notification_outbox set read_at = now() where user_id = ${userId} and channel = 'in_app' and read_at is null`;
  } else if (ids.length) {
    await tx`update notification_outbox set read_at = now() where user_id = ${userId} and id = any(${ids})`;
  }
}

export async function deliveryDiagnostics(tx: Tx, userId: string, limit = 40) {
  return tx<{ id: string; channel: string; reminderType: string; status: string; scheduledAt: Date; sentAt: Date | null; attempts: number; lastError: string | null; cancelReason: string | null; payloadJson: { title?: string } }[]>`
    select id, channel, reminder_type, status, scheduled_at, sent_at, attempts, last_error, cancel_reason, payload_json
    from notification_outbox where user_id = ${userId}
    order by scheduled_at desc limit ${limit}`;
}

// ---------------------------------------------------------------------------
// Worker side
// ---------------------------------------------------------------------------
export interface TelegramOutgoing {
  chatId: number;
  text: string;
  buttons: { text: string; callbackData?: string; url?: string }[][];
}

export interface ChannelSenders {
  telegram?: (m: TelegramOutgoing) => Promise<{ messageId: string }>;
  webPush?: (sub: { endpoint: string; p256dh: string; auth: string }, payload: Record<string, unknown>) => Promise<void>;
}

const STALE_MINUTES = 30;
const MAX_ATTEMPTS = 3;
const BACKOFF_MIN = [1, 5, 15];

interface DueRow {
  id: string;
  userId: string;
  eventId: string | null;
  channel: Channel;
  kind: string;
  reminderType: string;
  messageKey: string;
  scheduledAt: Date;
  attempts: number;
  payloadJson: Record<string, unknown>;
}

export function telegramButtons(eventId: string, msg: ReminderMessage): TelegramOutgoing['buttons'] {
  const appUrl = env().APP_URL;
  const row: TelegramOutgoing['buttons'][number] = [];
  for (const b of msg.buttons) {
    if (b.action.type === 'transition') row.push({ text: b.label, callbackData: `ev:${b.action.transition}:${eventId}` });
    else if (b.action.type === 'extra_work') row.push({ text: b.label, callbackData: `xw:${b.action.minutes ?? 0}:${eventId}` });
    else if (b.action.type === 'open' && appUrl.startsWith('https://')) row.push({ text: b.label, url: appUrl + b.action.path });
  }
  return row.length ? [row] : [];
}

export interface ProcessReport {
  picked: number;
  sent: number;
  failed: number;
  skipped: number;
  cancelled: number;
}

/** Send due outbox rows. Safe to run concurrently (SKIP LOCKED) and repeatedly (status machine). */
export async function processDueNotifications(now: DateTime, senders: ChannelSenders, limit = 100): Promise<ProcessReport> {
  const report: ProcessReport = { picked: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0 };
  // Clear the backlog first (e.g. after downtime): stale reminders are skipped in one statement,
  // so they never delay fresh ones and are never sent late.
  const stale = await withSystem((tx) => tx`
    update notification_outbox set status = 'skipped', cancel_reason = 'stale'
    where status = 'scheduled' and (
      (kind <> 'review' and scheduled_at < ${now.minus({ minutes: STALE_MINUTES }).toJSDate()}) or
      (kind = 'review' and scheduled_at < ${now.minus({ minutes: 120 }).toJSDate()}))
    returning id`);
  report.skipped += stale.length;
  const due = await withSystem((tx) => tx<DueRow[]>`
    select id, user_id, event_id, channel, kind, reminder_type, message_key, scheduled_at, attempts, payload_json
    from notification_outbox
    where status = 'scheduled' and scheduled_at <= ${now.toJSDate()}
      and (next_attempt_at is null or next_attempt_at <= ${now.toJSDate()})
    order by scheduled_at limit ${limit}`);
  report.picked = due.length;
  for (const row of due) {
    try {
      const outcome = await processOne(row, now, senders);
      report[outcome]++;
    } catch {
      report.failed++;
    }
  }
  return report;
}

/** Does this outbox row (or, for a repeat, its base reminder) still correspond to the event's current times? */
async function stillMatchesPlan(
  tx: Tx,
  row: DueRow,
  ev: { id: string; kind: EventKind; title: string; startAt: Date; endAt: Date; templateReminder: ReminderSpec | null },
): Promise<boolean> {
  let type = row.reminderType;
  let at = DateTime.fromJSDate(row.scheduledAt, { zone: 'utc' });
  if (type === 'repeat') {
    const baseKey = (row.payloadJson as { baseKey?: string }).baseKey;
    if (!baseKey) return true;
    const [base] = await tx<{ reminderType: string; scheduledAt: Date }[]>`
      select reminder_type, scheduled_at from notification_outbox where user_id = ${row.userId} and message_key = ${baseKey}`;
    if (!base) return true;
    type = base.reminderType;
    at = DateTime.fromJSDate(base.scheduledAt, { zone: 'utc' });
  }
  const planned = remindersForEvent(
    {
      id: ev.id,
      kind: ev.kind,
      title: ev.title,
      startAt: DateTime.fromJSDate(ev.startAt, { zone: 'utc' }),
      endAt: DateTime.fromJSDate(ev.endAt, { zone: 'utc' }),
    },
    effectiveSpec(ev.kind, ev.templateReminder),
  );
  return planned.some((p) => p.reminderType === type && Math.abs(p.scheduledAt.diff(at, 'minutes').minutes) < 1);
}

async function processOne(row: DueRow, now: DateTime, senders: ChannelSenders): Promise<'sent' | 'failed' | 'skipped' | 'cancelled'> {
  return withUser(row.userId, async (tx) => {
    // lock order event → outbox, the same as an answer (transitionEvent → acknowledge): no deadlock
    let ev: { id: string; kind: EventKind; title: string; status: EventStatus; startAt: Date; endAt: Date; templateReminder: ReminderSpec | null } | undefined;
    if (row.eventId) {
      [ev] = await tx<NonNullable<typeof ev>[]>`
        select e.id, e.kind, e.title, e.status, e.start_at, e.end_at, t.reminder as template_reminder
        from schedule_events e left join schedule_templates t on t.id = e.template_id
        where e.id = ${row.eventId} for update of e`;
    }
    const [locked] = await tx<{ status: string }[]>`
      select status from notification_outbox where id = ${row.id} for update skip locked`;
    if (!locked || locked.status !== 'scheduled') return 'skipped';
    const ctx = await loadContext(tx, row.userId);

    const setStatus = async (status: string, extra: { reason?: string; error?: string } = {}) => {
      await tx`update notification_outbox set status = ${status}, cancel_reason = ${extra.reason ?? null},
                 last_error = ${extra.error ?? null} where id = ${row.id}`;
    };

    if (row.eventId) {
      if (!ev || !isRemindable(ev.kind, ev.status)) {
        await setStatus('cancelled', { reason: 'answered_or_removed' });
        return 'cancelled';
      }
      // the event moved (e.g. to another day, beyond the reconcile window): this reminder is for the old time
      if (!(await stillMatchesPlan(tx, row, ev))) {
        await setStatus('cancelled', { reason: 'plan_changed' });
        return 'cancelled';
      }
    }
    const scheduled = DateTime.fromJSDate(row.scheduledAt, { zone: 'utc' });
    const staleLimit = row.kind === 'review' ? 120 : STALE_MINUTES;
    if (now.diff(scheduled, 'minutes').minutes > staleLimit) {
      await setStatus('skipped', { reason: 'stale' });
      return 'skipped';
    }
    if (row.kind !== 'review' && inQuietHours(now, ctx.tz, ctx.profile.quietHours)) {
      await setStatus('skipped', { reason: 'quiet_hours' });
      return 'skipped';
    }
    if (row.channel !== 'in_app') {
      const today = localDateOf(now, ctx.tz);
      const dayStart = DateTime.fromISO(today, { zone: ctx.tz }).toUTC().toJSDate();
      const [cnt] = await tx<{ n: number }[]>`
        select count(*)::int as n from notification_outbox
        where user_id = ${row.userId} and channel = ${row.channel} and sent_at >= ${dayStart}`;
      if ((cnt?.n ?? 0) >= ctx.prefs.notifications.maxPerDay && row.kind !== 'review') {
        await setStatus('skipped', { reason: 'daily_limit' });
        return 'skipped';
      }
    }

    let pendingCount = 0;
    if (ev?.kind === 'review') {
      const today = localDateOf(now, ctx.tz);
      const [p] = await tx<{ n: number }[]>`
        select count(*)::int as n from schedule_events
        where user_id = ${row.userId} and local_date = ${today} and end_at < ${now.toJSDate()}
          and status in ('planned','notified','unanswered') and kind in ('meal_breakfast','meal_lunch','meal_dinner','workout','own_project','task','extra_work','work')`;
      pendingCount = p?.n ?? 0;
    }
    const msg = ev
      ? reminderMessage(
          {
            id: ev.id,
            kind: ev.kind,
            title: ev.title,
            startAt: DateTime.fromJSDate(ev.startAt, { zone: 'utc' }),
            endAt: DateTime.fromJSDate(ev.endAt, { zone: 'utc' }),
          },
          row.reminderType === 'repeat' ? 'repeat' : (row.reminderType as 'start'),
          ctx.tz,
          { pendingCount },
        )
      : { title: String(row.payloadJson.title ?? 'Напоминание'), body: String(row.payloadJson.body ?? ''), buttons: [], path: '/today' };

    let status: 'sent' | 'delivered_unknown' = 'sent';
    let providerId: string | null = null;
    try {
      if (row.channel === 'telegram') {
        if (!senders.telegram) throw new Error('telegram sender not configured');
        const [conn] = await tx<{ chatId: number }[]>`
          select chat_id from telegram_connections where user_id = ${row.userId} and is_active and notification_enabled`;
        if (!conn) {
          await setStatus('cancelled', { reason: 'telegram_disconnected' });
          return 'cancelled';
        }
        const res = await senders.telegram({
          chatId: conn.chatId,
          text: `<b>${escapeHtml(msg.title)}</b>\n${escapeHtml(msg.body)}`,
          buttons: ev ? telegramButtons(ev.id, msg) : [],
        });
        providerId = res.messageId;
      } else if (row.channel === 'web_push') {
        if (!senders.webPush) throw new Error('web push sender not configured');
        const subs = await tx<{ id: string; endpoint: string; p256dh: string; auth: string }[]>`
          select id, endpoint, p256dh, auth from push_subscriptions where user_id = ${row.userId} and disabled_at is null`;
        if (!subs.length) {
          await setStatus('cancelled', { reason: 'no_push_subscription' });
          return 'cancelled';
        }
        let delivered = 0;
        let lastErr = '';
        for (const s of subs) {
          try {
            await senders.webPush(s, {
              title: msg.title,
              body: msg.body,
              url: msg.path,
              tag: row.eventId ?? row.id,
              outboxId: row.id,
              eventId: row.eventId,
              // iOS ignores notification buttons; Android / desktop Chrome show up to two
              actions: msg.buttons
                .filter((b) => b.action.type === 'transition')
                .slice(0, 2)
                .map((b) => ({ action: b.action.type === 'transition' ? b.action.transition : 'open', title: b.label })),
            });
            delivered++;
            await tx`update push_subscriptions set last_success_at = now() where id = ${s.id}`;
          } catch (err) {
            const code = (err as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) await tx`update push_subscriptions set disabled_at = now() where id = ${s.id}`;
            lastErr = `push ${code ?? ''} ${(err as Error).message ?? ''}`.trim();
          }
        }
        if (!delivered) throw new Error(lastErr || 'push failed');
        status = 'delivered_unknown'; // push service accepted; device delivery is not confirmed
      }
    } catch (err) {
      const attempts = row.attempts + 1;
      const message = ((err as Error).message ?? 'error').slice(0, 300);
      if (attempts >= MAX_ATTEMPTS) {
        await tx`update notification_outbox set status = 'failed', attempts = ${attempts}, last_error = ${message} where id = ${row.id}`;
        return 'failed';
      }
      const backoff = BACKOFF_MIN[attempts - 1] ?? 15;
      await tx`update notification_outbox set attempts = ${attempts}, last_error = ${message},
                 next_attempt_at = ${now.plus({ minutes: backoff }).toJSDate()} where id = ${row.id}`;
      return 'failed';
    }

    await tx`update notification_outbox set status = ${status}, sent_at = ${now.toJSDate()}, attempts = attempts + 1,
               provider_message_id = ${providerId}, payload_json = ${tx.json({ ...row.payloadJson, ...msg } as never)}
             where id = ${row.id}`;
    if (ev && (ev.status === 'planned' || ev.status === 'snoozed')) {
      // a snoozed event that was reminded again is waiting for an answer like any other (→ unanswered later)
      await tx`update schedule_events set status = 'notified', status_changed_at = now() where id = ${ev.id} and status in ('planned', 'snoozed')`;
    }
    // one repeat for important reminders (NT-02); cancelled automatically when answered (NT-03)
    if (ev && row.kind === 'important' && row.reminderType !== 'repeat' && ctx.prefs.notifications.maxRepeats > 0) {
      const at = now.plus({ minutes: ctx.prefs.notifications.repeatMinutes });
      const evEnd = DateTime.fromJSDate(ev.endAt, { zone: 'utc' });
      if (at < evEnd.plus({ minutes: 30 })) {
        await tx`
          insert into notification_outbox (user_id, event_id, channel, kind, reminder_type, message_key, scheduled_at, payload_json)
          values (${row.userId}, ${ev.id}, ${row.channel}, 'important', 'repeat',
                  ${repeatKey(row.userId, ev.id, row.reminderType, row.channel)}, ${at.toJSDate()},
                  ${tx.json({ baseKey: row.messageKey, title: ev.title } as never)})
          on conflict (message_key) do nothing`;
      }
    }
    return 'sent';
  });
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Past events that were notified but never answered become `unanswered` (not `missed`). */
export async function markUnanswered(now: DateTime): Promise<number> {
  const rows = await withSystem((tx) => tx`
    update schedule_events set status = 'unanswered', status_changed_at = now()
    where status = 'notified' and end_at < ${now.minus({ minutes: 30 }).toJSDate()}
    returning id`);
  return rows.length;
}

/** Reconcile reminders for every onboarded user (worker tick). */
export async function reconcileAllUsers(now: DateTime, ensure: (tx: Tx, ctx: UserContext) => Promise<void>): Promise<number> {
  const users = await withSystem((tx) => tx<{ userId: string }[]>`select user_id from profiles where is_onboarded`);
  for (const u of users) {
    await withUser(u.userId, async (tx) => {
      const ctx = await loadContext(tx, u.userId);
      await ensure(tx, ctx);
      await reconcileReminders(tx, ctx, now);
    });
  }
  return users.length;
}
