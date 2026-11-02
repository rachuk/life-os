import { DateTime } from 'luxon';
import { beforeAll, describe, expect, it } from 'vitest';
import { withSystem, withUser } from '@/server/db';
import { transitionEvent } from '@/server/services/planning';
import { loadContext, saveOnboarding } from '@/server/services/profile';
import { addCheckpoint, completeCheckpoint, createSkill, getSkill, skillsOverview, updateSkill } from '@/server/services/skills';
import { BASE_ONBOARDING, onboardUser } from '../helpers/db';

const tz = 'Europe/Lisbon';
const t = (iso: string) => DateTime.fromISO(iso, { zone: tz }).toUTC();
const SUNDAY = t('2026-11-01T20:00');
let userId: string;
let pt: string;

beforeAll(async () => {
  userId = await onboardUser('skills', SUNDAY);
});

const inU = <T,>(fn: (tx: Parameters<Parameters<typeof withUser>[1]>[0], ctx: Awaited<ReturnType<typeof loadContext>>) => Promise<T>) =>
  withUser(userId, async (tx) => fn(tx, await loadContext(tx, userId)));

describe('skills', () => {
  it('an active skill gets weekly sessions in the plan (not after 23:00, not inside work)', async () => {
    const r = await inU((tx, ctx) =>
      createSkill(tx, ctx, SUNDAY, { title: 'Португальский', area: 'language', levelScale: 'cefr', currentLevel: 1, targetLevel: 3, weeklyMinutes: 60, sessionMinutes: 20 }),
    );
    pt = r.skill.id;
    const events = await withSystem((tx) => tx<{ localDate: string; startAt: Date; endAt: Date }[]>`
      select local_date, start_at, end_at from schedule_events
      where user_id = ${userId} and kind = 'skill' and local_date between '2026-11-02' and '2026-11-08' and status = 'planned' order by start_at`);
    expect(events).toHaveLength(3);
    for (const e of events) {
      const end = DateTime.fromJSDate(e.endAt).setZone(tz).toFormat('HH:mm');
      const start = DateTime.fromJSDate(e.startAt).setZone(tz).toFormat('HH:mm');
      expect(end <= '23:00').toBe(true);
      const isWorkday = DateTime.fromISO(e.localDate).weekday <= 5;
      if (isWorkday) expect(start >= '18:00').toBe(true);
    }
  });

  it('completing a planned session logs practice once; level does not change from minutes', async () => {
    const [ev] = await withSystem((tx) => tx<{ id: string }[]>`
      select id from schedule_events where user_id = ${userId} and kind = 'skill' and status = 'planned' and local_date >= '2026-11-02' order by start_at limit 1`);
    await inU((tx, ctx) => transitionEvent(tx, ctx, t('2026-11-03T21:00'), ev!.id, { action: 'complete' }));
    await inU((tx, ctx) => transitionEvent(tx, ctx, t('2026-11-03T21:00'), ev!.id, { action: 'complete' }));
    const logs = await withSystem((tx) => tx<{ minutes: number }[]>`select minutes from skill_practice_logs where skill_id = ${pt}`);
    expect(logs).toHaveLength(1);
    expect(logs[0]!.minutes).toBe(20);
    const o = await inU((tx, ctx) => skillsOverview(tx, ctx, t('2026-11-03T22:00')));
    expect(o.skills[0]!.weekMinutes).toBe(20);
    expect(o.skills[0]!.currentLevel).toBe(1);
  });

  it('only a passed checkpoint raises the level', async () => {
    const cp1 = await inU((tx, ctx) => addCheckpoint(tx, ctx, pt, { title: 'Записаться к стоматологу на португальском' }));
    await inU((tx, ctx) => completeCheckpoint(tx, ctx, t('2026-11-05T10:00'), cp1.id, { passed: false }));
    expect((await inU((tx) => getSkill(tx, userId, pt))).currentLevel).toBe(1);
    const cp2 = await inU((tx, ctx) => addCheckpoint(tx, ctx, pt, { title: '5 минут без подсказок' }));
    const r = await inU((tx, ctx) => completeCheckpoint(tx, ctx, t('2026-11-20T10:00'), cp2.id, { passed: true, resultLevel: 2 }));
    expect(r).toMatchObject({ level: 2, changed: true });
  });

  it('at most two active skills; the third goes to maintenance', async () => {
    await inU((tx, ctx) => createSkill(tx, ctx, SUNDAY, { title: 'Управление людьми', area: 'leadership', weeklyMinutes: 40, sessionMinutes: 20 }));
    const third = await inU((tx, ctx) => createSkill(tx, ctx, SUNDAY, { title: 'Речь', area: 'communication', weeklyMinutes: 40, sessionMinutes: 20 }));
    expect(third.skill.status).toBe('maintenance');
    expect(third.note).toMatch(/поддержку/);
    const again = await inU((tx, ctx) => updateSkill(tx, ctx, SUNDAY, third.skill.id, { status: 'active' }));
    expect(again.skill.status).toBe('maintenance');
  });

  it('saving the routine keeps skill templates enabled', async () => {
    await withUser(userId, (tx) => saveOnboarding(tx, userId, BASE_ONBOARDING));
    const rows = await withSystem((tx) => tx<{ enabled: boolean }[]>`select enabled from schedule_templates where user_id = ${userId} and key like 'skill:%'`);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.enabled)).toBe(true);
  });
});
