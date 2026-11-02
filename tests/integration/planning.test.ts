import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withUser } from '@/server/db';
import { AppError } from '@/server/http';
import {
  extraWorkCommit,
  extraWorkPreview,
  transitionEvent,
  undoVersion,
} from '@/server/services/planning';
import { loadContext } from '@/server/services/profile';
import { reconcileReminders } from '@/server/services/notifications';
import { count, onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const SUNDAY = DateTime.fromISO('2026-11-01T20:00', { zone: tz }).toUTC();
const TUESDAY_1755 = DateTime.fromISO('2026-11-03T17:55', { zone: tz }).toUTC();

let userId: string;

beforeAll(async () => {
  userId = await onboardUser('planner', SUNDAY);
});

describe('onboarding and materialisation (PL-01)', () => {
  it('creates work blocks on weekdays only and is idempotent', async () => {
    const work = await withSystem((tx) => tx<{ localDate: string }[]>`
      select local_date from schedule_events where user_id = ${userId} and kind = 'work' and local_date between '2026-11-02' and '2026-11-08' order by 1`);
    expect(work.map((w) => w.localDate)).toEqual(['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06']);
    const before = await count('select count(*) as n from schedule_events where user_id = $1', userId);
    await withUser(userId, async (tx) => {
      const ctx = await loadContext(tx, userId);
      const { ensureMaterialized } = await import('@/server/services/planning');
      const r = await ensureMaterialized(tx, ctx, SUNDAY, '2026-11-02', '2026-11-15');
      expect(r.created).toBe(0);
    });
    expect(await count('select count(*) as n from schedule_events where user_id = $1', userId)).toBe(before);
  });
});

describe('extra work preview / commit / undo', () => {
  const req = { date: '2026-11-03', startMode: 'after_work' as const, durationMinutes: 180, reason: 'важная задача' };

  it('PL-04: preview does not change the database', async () => {
    const events = await count('select count(*) as n from schedule_events where user_id = $1', userId);
    const versions = await count('select count(*) as n from plan_versions where user_id = $1', userId);
    const changes = await count("select count(*) as n from schedule_events where user_id = $1 and revision > 1", userId);
    const p = await withUser(userId, async (tx) => extraWorkPreview(tx, await loadContext(tx, userId), TUESDAY_1755, req));
    expect(p.canCommit).toBe(true);
    expect(p.changes.length).toBeGreaterThan(0);
    expect(await count('select count(*) as n from schedule_events where user_id = $1', userId)).toBe(events);
    expect(await count('select count(*) as n from plan_versions where user_id = $1', userId)).toBe(versions);
    expect(await count("select count(*) as n from schedule_events where user_id = $1 and revision > 1", userId)).toBe(changes);
  });

  it('PL-07: a stale plan version is rejected with 409 and a fresh preview', async () => {
    const p = await withUser(userId, async (tx) => extraWorkPreview(tx, await loadContext(tx, userId), TUESDAY_1755, req));
    const err = await withUser(userId, async (tx) =>
      extraWorkCommit(tx, await loadContext(tx, userId), TUESDAY_1755, { ...req, startTime: null, expectedPlanVersion: p.basePlanVersion + 7, acknowledgeRisks: false }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).status).toBe(409);
    expect((err as AppError).code).toBe('PLAN_VERSION_CONFLICT');
    expect(((err as AppError).details as { preview: unknown }).preview).toBeTruthy();
  });

  let versionId: string;
  let movedGymId: string;

  it('PL-05: commit creates the work block, moves compatible events and keeps history', async () => {
    const p = await withUser(userId, async (tx) => extraWorkPreview(tx, await loadContext(tx, userId), TUESDAY_1755, req));
    const res = await withUser(userId, async (tx) =>
      extraWorkCommit(tx, await loadContext(tx, userId), TUESDAY_1755, {
        ...req,
        startTime: null,
        expectedPlanVersion: p.basePlanVersion,
        acknowledgeRisks: p.requiresRiskAcknowledgement,
        fingerprint: p.fingerprint,
      }),
    );
    versionId = res.versionId;
    expect(res.createdEventIds.length).toBe(p.segments.length);
    const xw = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from schedule_events where user_id = ${userId} and kind = 'extra_work' and status = 'planned'`);
    expect(xw[0]!.n).toBe(p.segments.length);
    const history = await withSystem((tx) => tx<{ action: string; fromJson: unknown }[]>`
      select action, from_json from plan_changes where version_id = ${versionId}`);
    expect(history.some((h) => h.action === 'move' && h.fromJson)).toBe(true);
    const gym = p.changes.find((c) => c.kind === 'workout');
    expect(gym?.action).toBe('move');
    movedGymId = gym!.eventId;
    const [g] = await withSystem((tx) => tx<{ localDate: string }[]>`select local_date from schedule_events where id = ${movedGymId}`);
    expect(g!.localDate).toBe(gym!.to!.localDate);
    // sleep untouched
    const sleepChanged = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from schedule_events where user_id = ${userId} and kind = 'sleep' and revision > 1`);
    expect(sleepChanged[0]!.n).toBe(0);
  });

  it('PL-08: undo restores events and recalculates reminders', async () => {
    // reminders exist for the extra work end
    await withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), TUESDAY_1755));
    const xwReminders = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from notification_outbox o join schedule_events e on e.id = o.event_id
      where e.user_id = ${userId} and e.kind = 'extra_work' and o.status = 'scheduled'`);
    expect(xwReminders[0]!.n).toBeGreaterThan(0);

    await withUser(userId, async (tx) => undoVersion(tx, await loadContext(tx, userId), TUESDAY_1755, versionId));
    const [gym] = await withSystem((tx) => tx<{ localDate: string; status: string }[]>`select local_date, status from schedule_events where id = ${movedGymId}`);
    expect(gym!.localDate).toBe('2026-11-03');
    const active = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from schedule_events where user_id = ${userId} and kind = 'extra_work' and status <> 'cancelled'`);
    expect(active[0]!.n).toBe(0);
    const stale = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from notification_outbox o join schedule_events e on e.id = o.event_id
      where e.user_id = ${userId} and e.kind = 'extra_work' and o.status = 'scheduled'`);
    expect(stale[0]!.n).toBe(0);
    const gymReminder = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from notification_outbox where event_id = ${movedGymId} and status = 'scheduled'`);
    expect(gymReminder[0]!.n).toBe(1);
    const [v] = await withSystem((tx) => tx<{ status: string }[]>`select status from plan_versions where id = ${versionId}`);
    expect(v!.status).toBe('reverted');
  });
});

describe('event transitions', () => {
  it('NT-03 / NT-05: answering cancels pending reminders; snooze creates a new time and reminder', async () => {
    const [lunch] = await withSystem((tx) => tx<{ id: string; startAt: Date }[]>`
      select id, start_at from schedule_events where user_id = ${userId} and kind = 'meal_lunch' and local_date = '2026-11-04'`);
    const morning = DateTime.fromISO('2026-11-04T12:30', { zone: tz }).toUTC();
    await withUser(userId, async (tx) => reconcileReminders(tx, await loadContext(tx, userId), morning));
    const before = await withSystem((tx) => tx<{ scheduledAt: Date }[]>`
      select scheduled_at from notification_outbox where event_id = ${lunch!.id} and status = 'scheduled'`);
    expect(before).toHaveLength(1);

    const res = await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), morning, lunch!.id, { action: 'snooze', snoozeMinutes: 15 }));
    expect(res.event.status).toBe('snoozed');
    const after = await withSystem((tx) => tx<{ scheduledAt: Date }[]>`
      select scheduled_at from notification_outbox where event_id = ${lunch!.id} and status = 'scheduled'`);
    expect(after).toHaveLength(1);
    expect(after[0]!.scheduledAt.getTime() - before[0]!.scheduledAt.getTime()).toBe(15 * 60_000);

    await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), morning, lunch!.id, { action: 'start' }));
    const pending = await withSystem((tx) => tx<{ n: number }[]>`
      select count(*)::int as n from notification_outbox where event_id = ${lunch!.id} and status = 'scheduled'`);
    expect(pending[0]!.n).toBe(0);

    const again = await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), morning, lunch!.id, { action: 'start' }));
    expect(again.changed).toBe(false); // idempotent repeat
  });

  it('distinguishes started from completed', async () => {
    const [ev] = await withSystem((tx) => tx<{ id: string; status: string }[]>`
      select id, status from schedule_events where user_id = ${userId} and kind = 'meal_lunch' and local_date = '2026-11-04'`);
    expect(ev!.status).toBe('started');
    const r = await withUser(userId, async (tx) => transitionEvent(tx, await loadContext(tx, userId), DateTime.fromISO('2026-11-04T13:40', { zone: tz }).toUTC(), ev!.id, { action: 'complete' }));
    expect(r.event.status).toBe('completed');
    expect(r.event.actualMinutes).toBeGreaterThan(0);
  });
});
