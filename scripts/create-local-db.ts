import postgres from 'postgres';
import { loadEnv } from './_env';

/** Creates the databases named in DATABASE_URL and TEST_DATABASE_URL on a local server if missing. */
async function main() {
  loadEnv();
  const urls = [process.env.DATABASE_URL, process.env.TEST_DATABASE_URL].filter(Boolean) as string[];
  for (const u of urls) {
    const url = new URL(u);
    const name = url.pathname.slice(1);
    url.pathname = '/postgres';
    const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
    const exists = await sql`select 1 from pg_database where datname = ${name}`;
    if (!exists.length) {
      await sql.unsafe(`create database "${name.replace(/"/g, '')}"`);
      console.log(`✓ created database ${name}`);
    } else console.log(`= database ${name} exists`);
    await sql.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
