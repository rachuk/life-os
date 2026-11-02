import { param, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { suggestRescheduleSlots } from '@/server/services/planning';

/** Concrete free alternatives for «Перенести» (PRD §22.3: show alternatives, not just an error). */
export const GET = userRoute(async ({ user, params }) => inUser(user.id, (tx, ctx) => suggestRescheduleSlots(tx, ctx, now(), param(params, 'id'))));
