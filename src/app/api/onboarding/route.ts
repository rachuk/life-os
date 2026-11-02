import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { addDays, localDateOf, weekStartOf } from '@/domain/time';
import { ensureMaterialized, regenerateFuture } from '@/server/services/planning';
import { loadContext, onboardingSchema, saveOnboarding } from '@/server/services/profile';

/** Save onboarding / routine settings, rebuild templates and (re)build the current + next week. */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, onboardingSchema);
  return inUser(user.id, async (tx, before) => {
    const wasOnboarded = before.profile.isOnboarded;
    const result = await saveOnboarding(tx, user.id, input);
    const ctx = await loadContext(tx, user.id);
    const t = now();
    const today = localDateOf(t, ctx.tz);
    if (wasOnboarded) {
      const r = await regenerateFuture(tx, ctx, t);
      return { ...result, regenerated: r };
    }
    const m = await ensureMaterialized(tx, ctx, t, today, addDays(weekStartOf(today), 13));
    return { ...result, created: m.created, risks: m.risks };
  });
});
