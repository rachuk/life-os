import { NextResponse } from 'next/server';
import { withSystem } from '@/server/db';

/** Liveness/readiness probe for Docker and uptime checks. No user data. */
export async function GET() {
  try {
    await withSystem((tx) => tx`select 1`);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503 });
  }
}
