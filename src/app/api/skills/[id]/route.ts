import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { deleteSkill, skillPatchSchema, updateSkill } from '@/server/services/skills';

export const PATCH = userRoute(async ({ req, user, params }) => {
  const patch = await readJson(req, skillPatchSchema);
  return inUser(user.id, async (tx, ctx) => {
    const r = await updateSkill(tx, ctx, now(), param(params, 'id'), patch);
    return { status: r.skill.status, note: r.note };
  });
});

export const DELETE = userRoute(async ({ user, params }) =>
  inUser(user.id, async (tx, ctx) => {
    await deleteSkill(tx, ctx, now(), param(params, 'id'));
    return { ok: true };
  }),
);
