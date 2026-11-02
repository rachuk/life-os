import { createHash, randomBytes } from 'node:crypto';
import { withSystem } from '../db';
import { findUserByEmail } from './users';
import { verifyPassword } from './password';

export const SESSION_COOKIE = 'lifeos_session';
const SESSION_DAYS = 30;
const MAX_FAILURES = 8;
const WINDOW_MINUTES = 15;

export interface SessionUser {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createSession(userId: string, userAgent: string | null): Promise<{ token: string; expiresAt: Date }> {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400_000);
  await withSystem(async (tx) => {
    await tx`insert into sessions (id, user_id, expires_at, user_agent)
             values (${hashToken(token)}, ${userId}, ${expiresAt}, ${userAgent?.slice(0, 300) ?? null})`;
    await tx`delete from sessions where user_id = ${userId} and expires_at < now()`;
  });
  return { token, expiresAt };
}

export async function getSessionUser(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  return withSystem(async (tx) => {
    const [row] = await tx<(SessionUser & { lastSeenAt: Date })[]>`
      select u.id, u.email, u.display_name, u.role, s.last_seen_at
      from sessions s join users u on u.id = s.user_id
      where s.id = ${hashToken(token)} and s.expires_at > now() and u.disabled_at is null`;
    if (!row) return null;
    if (Date.now() - new Date(row.lastSeenAt).getTime() > 3600_000) {
      await tx`update sessions set last_seen_at = now(), expires_at = now() + interval '30 days' where id = ${hashToken(token)}`;
    }
    return { id: row.id, email: row.email, displayName: row.displayName, role: row.role };
  });
}

export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!token) return;
  await withSystem((tx) => tx`delete from sessions where id = ${hashToken(token)}`);
}

export type LoginResult =
  | { ok: true; userId: string; token: string; expiresAt: Date }
  | { ok: false; code: 'INVALID_CREDENTIALS' | 'RATE_LIMITED'; message: string };

/** Password login with throttling per email and per client key (PRD §19.1). */
export async function login(email: string, password: string, clientKey: string, userAgent: string | null): Promise<LoginResult> {
  const keys = [`email:${email.trim().toLowerCase()}`, `client:${clientKey}`];
  const limited = await withSystem(async (tx) => {
    const [r] = await tx<{ n: number }[]>`
      select count(*)::int as n from auth_attempts
      where key = any(${keys}) and success = false and created_at > now() - make_interval(mins => ${WINDOW_MINUTES})`;
    return r!.n >= MAX_FAILURES;
  });
  if (limited) return { ok: false, code: 'RATE_LIMITED', message: 'Слишком много попыток. Подожди 15 минут.' };

  const user = await withSystem((tx) => findUserByEmail(tx, email));
  const valid = !!user && !user.disabledAt && (await verifyPassword(password, user.passwordHash));
  await withSystem(async (tx) => {
    for (const k of keys) await tx`insert into auth_attempts (key, success) values (${k}, ${valid})`;
    await tx`delete from auth_attempts where created_at < now() - interval '1 day'`;
  });
  if (!valid || !user) return { ok: false, code: 'INVALID_CREDENTIALS', message: 'Неверный email или пароль' };
  const s = await createSession(user.id, userAgent);
  return { ok: true, userId: user.id, token: s.token, expiresAt: s.expiresAt };
}
