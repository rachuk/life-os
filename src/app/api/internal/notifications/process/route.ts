import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { env } from '@/server/env';
import { errorResponse } from '@/server/http';
import { runWorkerTick } from '@/server/worker/tick';
import { now } from '@/server/context';

/** Internal cron entry point (system cron / uptime pinger). Not a user endpoint: requires CRON_SECRET. */
export async function POST(req: Request) {
  try {
    const secret = env().CRON_SECRET;
    const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!secret || got.length !== secret.length || !timingSafeEqual(Buffer.from(got), Buffer.from(secret))) {
      return NextResponse.json({ code: 'FORBIDDEN', message: 'forbidden' }, { status: 403 });
    }
    return NextResponse.json(await runWorkerTick(now()));
  } catch (e) {
    return errorResponse(e);
  }
}
