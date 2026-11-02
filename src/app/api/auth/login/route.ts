import { cookies, headers } from 'next/headers';
import { NextResponse } from 'next/server';
import { z } from 'zod';
import { login, SESSION_COOKIE } from '@/server/auth/session';
import { assertSameOrigin, errorResponse, readJson } from '@/server/http';
import { env } from '@/server/env';

const schema = z.object({ email: z.string().trim().min(3).max(200), password: z.string().min(1).max(200) });

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const { email, password } = await readJson(req, schema);
    const h = await headers();
    const clientKey = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || h.get('x-real-ip') || 'local';
    const res = await login(email, password, clientKey, h.get('user-agent'));
    if (!res.ok) return NextResponse.json({ code: res.code, message: res.message }, { status: res.code === 'RATE_LIMITED' ? 429 : 401 });
    (await cookies()).set(SESSION_COOKIE, res.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: env().APP_URL.startsWith('https://'),
      path: '/',
      expires: res.expiresAt,
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
