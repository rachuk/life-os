import { z } from 'zod';
import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { addDays, isLocalDate, weekStartOf } from '@/domain/time';
import { ensureMaterialized } from '@/server/services/planning';

const schema = z.object({ weekStart: z.string().refine(isLocalDate) });

/** Build (materialise) a week from the confirmed routine; idempotent, returns placement risks. */
export const POST = userRoute(async ({ req, user }) => {
  const { weekStart } = await readJson(req, schema);
  const ws = weekStartOf(weekStart);
  return inUser(user.id, (tx, ctx) => ensureMaterialized(tx, ctx, now(), ws, addDays(ws, 6)));
});
