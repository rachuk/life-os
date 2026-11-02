import { z } from 'zod';
import { param, readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { deleteHabitEvent, setEventReason } from '@/server/services/habitChange';

const schema = z.object({ reason: z.string().trim().max(60).nullable() });

export const PATCH = userRoute(async ({ req, user, params }) => {
  const { reason } = await readJson(req, schema);
  return inUser(user.id, async (tx) => {
    await setEventReason(tx, user.id, param(params, 'eventId'), reason);
    return { ok: true };
  });
});

export const DELETE = userRoute(async ({ user, params }) =>
  inUser(user.id, async (tx) => {
    await deleteHabitEvent(tx, user.id, param(params, 'eventId'));
    return { ok: true };
  }),
);
