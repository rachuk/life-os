import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { withUser } from '@/server/db';
import { loadContext } from '@/server/services/profile';
import { createTask, listTasks } from '@/server/services/tasks';
import { onboardUser } from '../helpers/db';

const now = DateTime.fromISO('2026-11-01T20:00', { zone: 'Europe/Lisbon' }).toUTC();
let alice: string;
let bob: string;
let aliceTask: string;

beforeAll(async () => {
  alice = await onboardUser('alice', now);
  bob = await onboardUser('bob', now);
  aliceTask = await withUser(alice, async (tx) => (await createTask(tx, await loadContext(tx, alice), { title: 'Секретная задача Алисы', type: 'task', category: 'personal', priority: 'normal' })).id);
});

describe('SEC-01: row level security between two accounts', () => {
  it('bob cannot read alice rows even with a direct query', async () => {
    const rows = await withUser(bob, (tx) => tx`select id, title from tasks where id = ${aliceTask}`);
    expect(rows).toHaveLength(0);
    const all = await withUser(bob, (tx) => tx`select count(*)::int as n from tasks`);
    expect((all[0] as { n: number }).n).toBe(0);
    const tasks = await withUser(bob, async (tx) => listTasks(tx, await loadContext(tx, bob), 'all'));
    expect(tasks.find((t) => t.id === aliceTask)).toBeUndefined();
  });

  it('bob cannot update or delete alice rows', async () => {
    const upd = await withUser(bob, (tx) => tx`update tasks set title = 'hacked' where id = ${aliceTask} returning id`);
    expect(upd).toHaveLength(0);
    const del = await withUser(bob, (tx) => tx`delete from tasks where id = ${aliceTask} returning id`);
    expect(del).toHaveLength(0);
    const own = await withUser(alice, (tx) => tx<{ title: string }[]>`select title from tasks where id = ${aliceTask}`);
    expect(own[0]!.title).toBe('Секретная задача Алисы');
  });

  it('bob cannot insert rows on behalf of alice', async () => {
    const err = await withUser(bob, (tx) => tx`insert into tasks (user_id, title) values (${alice}, 'injected')`).catch((e) => e);
    expect(String((err as Error).message)).toMatch(/row-level security/);
  });

  it('schedule, plan history and outbox are isolated too', async () => {
    for (const table of ['schedule_events', 'plan_versions', 'notification_outbox', 'health_measurements', 'media_assets', 'audit_events']) {
      const r = await withUser(bob, (tx) => tx.unsafe(`select count(*)::int as n from ${table} where user_id = $1`, [alice]));
      expect((r[0] as unknown as { n: number }).n, table).toBe(0);
    }
  });

  it('users table exposes only the own row and never the password hash', async () => {
    const r = await withUser(bob, (tx) => tx`select id, email from users`);
    expect(r).toHaveLength(1);
    const err = await withUser(bob, (tx) => tx`select password_hash from users`).catch((e) => e);
    expect(String((err as Error).message)).toMatch(/permission denied/);
    const sess = await withUser(bob, (tx) => tx`select * from sessions`).catch((e) => e);
    expect(String((sess as Error).message)).toMatch(/permission denied/);
  });
});
