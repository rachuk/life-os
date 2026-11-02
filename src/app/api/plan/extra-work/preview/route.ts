import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { extraWorkPreview, extraWorkRequestSchema } from '@/server/services/planning';

/** PL-04: computes the diff only — never writes. */
export const POST = userRoute(async ({ req, user }) => {
  const r = await readJson(req, extraWorkRequestSchema);
  return inUser(user.id, (tx, ctx) =>
    extraWorkPreview(tx, ctx, now(), { date: r.date, startMode: r.startMode, startTime: r.startTime ?? null, durationMinutes: r.durationMinutes, reason: r.reason ?? null }),
  );
});
