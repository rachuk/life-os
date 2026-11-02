import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { archiveProgram, programOverview, programPatchSchema, updateProgram } from '@/server/services/habitChange';

export const GET = userRoute(async ({ user, params }) => inUser(user.id, (tx, ctx) => programOverview(tx, ctx, now(), param(params, 'id'))));

export const PATCH = userRoute(async ({ req, user, params }) => {
  const patch = await readJson(req, programPatchSchema);
  return inUser(user.id, async (tx, ctx) => ({ program: await updateProgram(tx, ctx, param(params, 'id'), patch) }));
});

export const DELETE = userRoute(async ({ user, params }) =>
  inUser(user.id, async (tx, ctx) => {
    await archiveProgram(tx, ctx, param(params, 'id'));
    return { ok: true };
  }),
);
