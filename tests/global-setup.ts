import postgres from 'postgres';
import { migrate } from '../scripts/migrate';

/** Recreates the test database schema from migrations before the run. */
export default async function setup() {
  const url = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/lifeos_test';
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/test/.test(name)) throw new Error(`Refusing to reset non-test database "${name}"`);
  u.pathname = '/postgres';
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  const exists = await admin`select 1 from pg_database where datname = ${name}`;
  if (!exists.length) await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const db = postgres(url, { max: 1, onnotice: () => {} });
  await db.unsafe('drop schema if exists public cascade; drop schema if exists app cascade; create schema public;');
  await db.end();
  await migrate(url, () => {});
}
