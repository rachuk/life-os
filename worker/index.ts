import { loadEnv } from '../scripts/_env';

/**
 * `pnpm worker` — long-running reminder worker (PRD §12.4, §15.1). Every 30 s: materialise the next
 * days, reconcile reminders, mark unanswered events, send due notifications (in-app / Telegram /
 * web push), purge expired media. Safe to restart: all steps are idempotent.
 */
loadEnv();

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 30_000);

async function main() {
  const { runWorkerTick } = await import('../src/server/worker/tick');
  const { now } = await import('../src/server/context');
  const { closeDb } = await import('../src/server/db');
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    console.log('[worker] stopping…');
    await closeDb();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  console.log(`[worker] started, interval ${INTERVAL_MS / 1000}s`);
  let first = true;
  while (!stopping) {
    const started = Date.now();
    try {
      const r = await runWorkerTick(now(), undefined, { forceReconcile: first });
      first = false;
      const n = r.notifications as { picked: number; sent: number; failed: number; skipped: number; cancelled: number };
      if (n.picked || r.unanswered || r.purged) {
        console.log(`[worker] ${r.at} picked=${n.picked} sent=${n.sent} failed=${n.failed} skipped=${n.skipped} cancelled=${n.cancelled} unanswered=${r.unanswered} purged=${r.purged}`);
      }
    } catch (e) {
      console.error('[worker] tick failed:', (e as Error).message.split('\n')[0]);
    }
    await new Promise((res) => setTimeout(res, Math.max(1000, INTERVAL_MS - (Date.now() - started))));
  }
}

main();
