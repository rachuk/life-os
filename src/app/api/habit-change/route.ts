import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { createProgram, listPrograms, programOverview, programSetupSchema } from '@/server/services/habitChange';

export const GET = userRoute(async ({ user }) =>
  inUser(user.id, async (tx, ctx) => {
    const programs = await listPrograms(tx, user.id);
    return { programs: await Promise.all(programs.map((p) => programOverview(tx, ctx, now(), p.id))) };
  }),
);

export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, programSetupSchema);
  return inUser(user.id, async (tx, ctx) => ({ program: await createProgram(tx, ctx, now(), input) }));
});
