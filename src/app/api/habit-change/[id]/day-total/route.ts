import { param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { dayTotalSchema, setDayTotal } from '@/server/services/habitChange';

export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, dayTotalSchema);
  return inUser(user.id, async (tx, ctx) => {
    await setDayTotal(tx, ctx, now(), param(params, 'id'), input);
    return { ok: true };
  });
});
