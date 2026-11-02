import { z } from 'zod';
import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { attachAiCommentary, generateWeeklyReview, getWeeklyReview } from '@/server/services/weeklyReview';

const schema = z.object({ weekStart: z.string().max(10).nullable().optional() });

/**
 * Deterministic facts + patterns + proposals, upserted by (user, week). Regeneration keeps
 * decisions. The optional AI comment runs afterwards, outside the DB transaction, and only
 * on aggregated facts; any failure leaves the rule-based text.
 */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, schema);
  const t = now();
  const view = await inUser(user.id, (tx, ctx) => generateWeeklyReview(tx, ctx, t, input.weekStart));
  if (!view.ai.eligible) return view;
  await attachAiCommentary(user.id, view.weekStart, t);
  return inUser(user.id, (tx, ctx) => getWeeklyReview(tx, ctx, t, view.weekStart));
});
