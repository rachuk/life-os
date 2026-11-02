import { param, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { undoVersion } from '@/server/services/planning';

export const POST = userRoute(async ({ user, params }) => inUser(user.id, (tx, ctx) => undoVersion(tx, ctx, now(), param(params, 'id'))));
