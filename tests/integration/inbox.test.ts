import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withUser } from '@/server/db';
import { captureText, confirmInboxItem } from '@/server/services/inbox';
import { loadContext } from '@/server/services/profile';
import { onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const now = DateTime.fromISO('2026-11-01T20:00', { zone: tz }).toUTC();
let userId: string;

beforeAll(async () => {
  userId = await onboardUser('inbox', now);
});

describe('inbox capture → proposals → atomic confirmation', () => {
  it('nothing is created before confirmation; confirmation creates task + shopping; repeat is idempotent', async () => {
    const r = await captureText(userId, now, { text: 'напомни завтра написать брокеру, купить бананы', idempotencyKey: 'k-1' });
    expect(r.item.parser).toBe('rules');
    expect(r.item.proposalsJson.map((p) => p.action.type)).toEqual(['create_task', 'add_shopping_item']);
    const before = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from tasks where user_id = ${userId}`);
    expect(before[0]!.n).toBe(0);

    // same idempotency key (e.g. double tap / repeated webhook) → same item, no second parse
    const again = await captureText(userId, now, { text: 'напомни завтра написать брокеру, купить бананы', idempotencyKey: 'k-1' });
    expect(again.duplicate).toBe(true);
    expect(again.item.id).toBe(r.item.id);

    const c1 = await withUser(userId, async (tx) => confirmInboxItem(tx, await loadContext(tx, userId), now, r.item.id, { selected: [0, 1] }));
    expect(c1.applied).toHaveLength(2);
    const c2 = await withUser(userId, async (tx) => confirmInboxItem(tx, await loadContext(tx, userId), now, r.item.id, { selected: [0, 1] }));
    expect(c2.alreadyProcessed).toBe(true);

    const tasks = await withSystem((tx) => tx<{ title: string; dueDate: string | null; category: string }[]>`select title, due_date, category from tasks where user_id = ${userId}`);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.dueDate).toBe('2026-11-02');
    const items = await withSystem((tx) => tx<{ name: string }[]>`select name from shopping_items where user_id = ${userId}`);
    expect(items.map((i) => i.name)).toEqual(['Бананы']);
  });

  it('TASK-02: an undated idea gets no deadline; a workout request moves the weekly workout instead of adding a third', async () => {
    const r = await captureText(userId, now, { text: 'в субботу хочу в зал в 11, подумать про страховку' });
    const types = r.item.proposalsJson.map((p) => p.action.type);
    expect(types).toEqual(['schedule_workout', 'idea']);
    await withUser(userId, async (tx) => confirmInboxItem(tx, await loadContext(tx, userId), now, r.item.id, { selected: [0, 1] }));
    const idea = await withSystem((tx) => tx<{ dueDate: string | null; status: string }[]>`select due_date, status from tasks where user_id = ${userId} and type = 'idea'`);
    expect(idea[0]).toMatchObject({ dueDate: null, status: 'someday' });
    const workouts = await withSystem((tx) => tx<{ localDate: string }[]>`
      select local_date from schedule_events where user_id = ${userId} and kind = 'workout' and local_date between '2026-11-02' and '2026-11-08' and status <> 'cancelled' order by local_date`);
    expect(workouts).toHaveLength(2);
    expect(workouts.map((w) => w.localDate)).toContain('2026-11-07');
  });

  it('only selected proposals are applied; extra work is deferred to the preview flow', async () => {
    const r = await captureText(userId, now, { text: 'нужно поработать 2 часа, купить хлеб' });
    const c = await withUser(userId, async (tx) => confirmInboxItem(tx, await loadContext(tx, userId), now, r.item.id, { selected: [0] }));
    expect(c.deferred.map((d) => d.action.type)).toEqual(['extra_work']);
    const extra = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from schedule_events where user_id = ${userId} and kind = 'extra_work'`);
    expect(extra[0]!.n).toBe(0);
    const bread = await withSystem((tx) => tx<{ n: number }[]>`select count(*)::int as n from shopping_items where user_id = ${userId} and name = 'Хлеб'`);
    expect(bread[0]!.n).toBe(0);
  });
});
