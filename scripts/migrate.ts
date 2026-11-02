import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import postgres from 'postgres';
import { loadEnv } from './_env';

/** Applies db/migrations/*.sql in order, once each, inside a transaction per file. */
export async function migrate(databaseUrl: string, log = console.log): Promise<string[]> {
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  const applied: string[] = [];
  try {
    await sql`create table if not exists schema_migrations (
      name text primary key, checksum text not null, applied_at timestamptz not null default now())`;
    const dir = resolve(process.cwd(), 'db/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const done = new Map((await sql<{ name: string; checksum: string }[]>`select name, checksum from schema_migrations`).map((r) => [r.name, r.checksum]));
    for (const f of files) {
      const body = readFileSync(join(dir, f), 'utf8');
      const sum = createHash('sha256').update(body).digest('hex');
      if (done.has(f)) {
        if (done.get(f) !== sum) log(`! ${f} was modified after being applied (checksum differs) — create a new migration instead`);
        continue;
      }
      await sql.begin(async (tx) => {
        await tx.unsafe(body);
        await tx`insert into schema_migrations (name, checksum) values (${f}, ${sum})`;
      });
      applied.push(f);
      log(`✓ applied ${f}`);
    }
    if (!applied.length) log('Database is up to date.');
  } finally {
    await sql.end({ timeout: 5 });
  }
  return applied;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  loadEnv();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set (see .env.example)');
    process.exit(1);
  }
  migrate(url).catch((e) => {
    console.error('Migration failed:', e.message);
    process.exit(1);
  });
}
