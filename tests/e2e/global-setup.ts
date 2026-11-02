import postgres from 'postgres';
import { migrate } from '../../scripts/migrate';

export default async function globalSetup() {
  const url = process.env.E2E_DATABASE_URL ?? 'postgres://vik@localhost:5432/lifeos_e2e';
  const u = new URL(url);
  const name = u.pathname.slice(1);
  if (!/e2e|test/.test(name)) throw new Error(`Refusing to reset ${name}`);
  u.pathname = '/postgres';
  const admin = postgres(u.toString(), { max: 1, onnotice: () => {} });
  if (!(await admin`select 1 from pg_database where datname = ${name}`).length) await admin.unsafe(`create database "${name}"`);
  await admin.end();
  const db = postgres(url, { max: 1, onnotice: () => {} });
  await db.unsafe('drop schema if exists public cascade; drop schema if exists app cascade; create schema public;');
  await db.end();
  await migrate(url, () => {});
}
