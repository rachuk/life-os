import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { createUser } from '@/server/auth/users';
import { withSystem, withUser } from '@/server/db';
import { ensureMaterialized } from '@/server/services/planning';
import { loadContext, saveOnboarding, type OnboardingInput } from '@/server/services/profile';

export const PASSWORD = 'correct-horse-battery';

export async function makeUser(prefix = 'user'): Promise<string> {
  const u = await createUser({ email: `${prefix}-${randomUUID().slice(0, 8)}@test.local`, password: PASSWORD, role: 'test' });
  return u.id;
}

export const BASE_ONBOARDING: OnboardingInput = {
  timezone: 'Europe/Lisbon',
  workDays: [1, 2, 3, 4, 5],
  workStart: '09:00',
  workEnd: '18:00',
  morningPrepMinutes: 60,
  wakeTime: '08:00',
  bedTime: '00:00',
  gymDays: [2, 4],
};

export async function onboardUser(prefix: string, now: DateTime, over: Partial<OnboardingInput> = {}): Promise<string> {
  const id = await makeUser(prefix);
  await withUser(id, (tx) => saveOnboarding(tx, id, { ...BASE_ONBOARDING, ...over }));
  await withUser(id, async (tx) => {
    const ctx = await loadContext(tx, id);
    await ensureMaterialized(tx, ctx, now, now.setZone(ctx.tz).toISODate()!, '2026-11-15');
  });
  return id;
}

export async function count(sqlText: string, userId: string): Promise<number> {
  return withSystem(async (tx) => {
    const r = await tx.unsafe(sqlText, [userId]);
    return Number((r[0] as unknown as { n: number }).n);
  });
}
