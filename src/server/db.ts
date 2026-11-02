import postgres from 'postgres';
import { env } from './env';

/**
 * Database access.
 *  - `withUser(userId, fn)`: user-scoped transaction. Switches to the non-privileged role
 *    `lifeos_user` and sets `app.user_id`, so Row Level Security is enforced by Postgres itself.
 *  - `withSystem(fn)`: owner-level transaction for system jobs (auth, worker scans, telegram routing).
 *    Keep its use minimal and never pass user-supplied ids into it without checks.
 */

export type Sql = postgres.Sql<Record<string, unknown>>;
export type Tx = postgres.TransactionSql<Record<string, unknown>>;

declare global {
  var __lifeosSql: Sql | undefined;
}

function createSql(): Sql {
  const e = env();
  return postgres(e.DATABASE_URL, {
    max: e.DATABASE_POOL_MAX,
    idle_timeout: 30,
    connect_timeout: 15,
    prepare: true,
    onnotice: () => {},
    transform: { column: { from: postgres.toCamel, to: postgres.fromCamel }, undefined: null },
    types: {
      // keep calendar dates and wall-clock times as strings — never shift them through JS Date
      localdate: { to: 1082, from: [1082], serialize: (x: string) => x, parse: (x: string) => x },
      localtime: { to: 1083, from: [1083], serialize: (x: string) => x, parse: (x: string) => x.slice(0, 5) },
      numeric: { to: 1700, from: [1700], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
      int8: { to: 20, from: [20], serialize: (x: number | string) => String(x), parse: (x: string) => Number(x) },
    },
  }) as unknown as Sql;
}

export function sql(): Sql {
  if (!globalThis.__lifeosSql) globalThis.__lifeosSql = createSql();
  return globalThis.__lifeosSql;
}

export async function closeDb(): Promise<void> {
  if (globalThis.__lifeosSql) {
    await globalThis.__lifeosSql.end({ timeout: 5 });
    globalThis.__lifeosSql = undefined;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

export async function withUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!isUuid(userId)) throw new Error('withUser: invalid user id');
  return (await sql().begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId}, true)`;
    await tx.unsafe('set local role lifeos_user');
    return fn(tx as Tx);
  })) as T;
}

export async function withSystem<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return (await sql().begin(async (tx) => fn(tx as Tx))) as T;
}

/** First row or throw — for INSERT/UPDATE … RETURNING that must affect exactly one row. */
export function one<T>(rows: readonly T[]): T {
  const r = rows[0];
  if (r === undefined) throw new Error('Expected one row');
  return r;
}
