import { loadEnv } from './_env';

/**
 * Account management without a public sign-up (PRD §15.4):
 *   pnpm user:create <email> [--name "Имя"]      (password asked interactively or via LIFEOS_PASSWORD)
 *   pnpm user:reset-password <email>
 *   pnpm user:list
 */
async function readPassword(): Promise<string> {
  if (process.env.LIFEOS_PASSWORD) return process.env.LIFEOS_PASSWORD;
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = process.stdout as NodeJS.WriteStream & { _write?: unknown };
  process.stdout.write('Пароль (мин. 10 символов): ');
  const origWrite = out.write.bind(out);
  (out as { write: unknown }).write = (chunk: string | Uint8Array, ...rest: unknown[]) => (typeof chunk === 'string' && chunk !== '\n' && chunk !== '\r\n' ? true : (origWrite as (...a: unknown[]) => boolean)(chunk, ...rest));
  const pw = await rl.question('');
  (out as { write: unknown }).write = origWrite;
  rl.close();
  process.stdout.write('\n');
  return pw;
}

async function main() {
  loadEnv();
  const [cmd, email, ...rest] = process.argv.slice(2);
  const { createUser, setPassword } = await import('../src/server/auth/users');
  const { withSystem, closeDb } = await import('../src/server/db');
  try {
    if (cmd === 'create') {
      if (!email) throw new Error('Укажи email: pnpm user:create you@example.com');
      const nameIdx = rest.indexOf('--name');
      const name = nameIdx >= 0 ? rest[nameIdx + 1] : null;
      const role = rest.includes('--test') ? 'test' : 'owner';
      const u = await createUser({ email, password: await readPassword(), displayName: name ?? null, role });
      console.log(`✓ Пользователь создан: ${u.email} (${u.id}). Войди в веб-версии — откроется первая настройка.`);
    } else if (cmd === 'reset-password') {
      if (!email) throw new Error('Укажи email');
      await setPassword(email, await readPassword());
      console.log('✓ Пароль обновлён, все сессии закрыты.');
    } else if (cmd === 'list') {
      const rows = await withSystem((tx) => tx<{ email: string; role: string; createdAt: Date }[]>`select email, role, created_at from users order by created_at`);
      for (const r of rows) console.log(`${r.email}\t${r.role}\t${r.createdAt.toISOString()}`);
      if (!rows.length) console.log('Пользователей нет. Создай: pnpm user:create you@example.com');
    } else {
      console.log('Команды: create <email> [--name Имя] [--test] | reset-password <email> | list');
    }
  } finally {
    await closeDb();
  }
}

main().catch((e) => {
  console.error('Ошибка:', e.message);
  process.exit(1);
});
