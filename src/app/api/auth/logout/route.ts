import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { destroySession, SESSION_COOKIE } from '@/server/auth/session';
import { assertSameOrigin, errorResponse } from '@/server/http';

export async function POST(req: Request) {
  try {
    assertSameOrigin(req);
    const c = await cookies();
    await destroySession(c.get(SESSION_COOKIE)?.value);
    c.delete(SESSION_COOKIE);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return errorResponse(e);
  }
}
