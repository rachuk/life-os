import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { createSkill, skillInputSchema, skillsOverview } from '@/server/services/skills';

export const GET = userRoute(async ({ user }) => inUser(user.id, (tx, ctx) => skillsOverview(tx, ctx, now())));

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, skillInputSchema);
  return inUser(user.id, async (tx, ctx) => {
    const r = await createSkill(tx, ctx, now(), input);
    return { id: r.skill.id, status: r.skill.status, note: r.note };
  });
});
