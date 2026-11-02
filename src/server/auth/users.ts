import type { Tx } from '../db';
import { withSystem } from '../db';
import { hashPassword, validatePasswordStrength } from './password';

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export interface UserRow {
  id: string;
  email: string;
  displayName: string | null;
  role: 'owner' | 'member' | 'test';
  passwordHash: string | null;
  disabledAt: Date | null;
}

export async function findUserByEmail(tx: Tx, email: string): Promise<UserRow | null> {
  const [u] = await tx<UserRow[]>`
    select id, email, display_name, role, password_hash, disabled_at
    from users where email_normalized = ${normalizeEmail(email)}`;
  return u ?? null;
}

export async function createUser(input: {
  email: string;
  password: string;
  displayName?: string | null;
  role?: 'owner' | 'member' | 'test';
  timezone?: string;
}): Promise<{ id: string; email: string }> {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Некорректный email');
  const weak = validatePasswordStrength(input.password);
  if (weak) throw new Error(weak);
  const hash = await hashPassword(input.password);
  return withSystem(async (tx) => {
    const existing = await findUserByEmail(tx, email);
    if (existing) throw new Error('Пользователь с таким email уже есть');
    const [u] = await tx<{ id: string; email: string }[]>`
      insert into users (email, email_normalized, password_hash, display_name, role)
      values (${email}, ${normalizeEmail(email)}, ${hash}, ${input.displayName ?? null}, ${input.role ?? 'owner'})
      returning id, email`;
    await tx`insert into profiles (user_id, display_name, timezone) values (${u!.id}, ${input.displayName ?? null}, ${input.timezone ?? 'Europe/Lisbon'})`;
    return u!;
  });
}

export async function setPassword(email: string, password: string): Promise<void> {
  const weak = validatePasswordStrength(password);
  if (weak) throw new Error(weak);
  const hash = await hashPassword(password);
  await withSystem(async (tx) => {
    const u = await findUserByEmail(tx, email);
    if (!u) throw new Error('Пользователь не найден');
    await tx`update users set password_hash = ${hash} where id = ${u.id}`;
    await tx`delete from sessions where user_id = ${u.id}`;
  });
}

export async function countUsers(): Promise<number> {
  return withSystem(async (tx) => {
    const [r] = await tx<{ n: number }[]>`select count(*)::int as n from users`;
    return r!.n;
  });
}
