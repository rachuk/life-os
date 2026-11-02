import { DateTime } from 'luxon';
import { withUser, type Tx } from './db';
import { loadContext, type UserContext } from './services/profile';

const started = Date.now();

/**
 * Current instant. In development/test LIFEOS_FAKE_NOW (ISO) shifts the clock so scenarios like
 * "Tuesday 17:55" can be checked end-to-end; it is ignored in production.
 */
export function now(): DateTime {
  const fake = process.env.LIFEOS_FAKE_NOW;
  if (fake && process.env.NODE_ENV !== 'production') {
    const base = DateTime.fromISO(fake, { setZone: true });
    if (base.isValid) return base.toUTC().plus({ milliseconds: Date.now() - started });
  }
  return DateTime.utc();
}

export async function inUser<T>(userId: string, fn: (tx: Tx, ctx: UserContext) => Promise<T>): Promise<T> {
  return withUser(userId, async (tx) => fn(tx, await loadContext(tx, userId)));
}
