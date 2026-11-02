import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { createSession, SESSION_COOKIE } from '@/server/auth/session';
import { createUser } from '@/server/auth/users';
import { AppError, assertSameOrigin, errorResponse, readJson } from '@/server/http';
import { env } from '@/server/env';

const schema = z.object({
  email: z.string().trim().email('Некорректный email').max(200),
  password: z.string().min(10, 'Пароль — минимум 10 символов').max(200),
  displayName: z.string().trim().max(80).optional(),
});

/** Registration is closed by default (PRD §15.4); enabled only with SIGNUP_MODE=open (dev/test accounts). */
export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    if (env().SIGNUP_MODE !== 'open') throw new AppError('SIGNUP_CLOSED', 'Регистрация закрыта. Аккаунт может создать администратор сервера.', 403);
    const input = await readJson(req, schema);
    let user: { id: string };
    try {
      user = await createUser({ email: input.email, password: input.password, displayName: input.displayName ?? null, role: 'owner' });
    } catch (e) {
      throw new AppError('SIGNUP_FAILED', (e as Error).message, 422);
    }
    const s = await createSession(user.id, (await headers()).get('user-agent'));
    (await cookies()).set(SESSION_COOKIE, s.token, { httpOnly: true, sameSite: 'lax', secure: env().APP_URL.startsWith('https://'), path: '/', expires: s.expiresAt });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
