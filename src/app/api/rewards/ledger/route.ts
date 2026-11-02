import { readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { applyLedgerAction, ledgerActionSchema } from '@/server/services/rewards';

/** approve / reject / fund (marked by the user after their own transfer) / redeem / adjust. */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, ledgerActionSchema);
  return inUser(user.id, (tx, ctx) => applyLedgerAction(tx, ctx, now(), input));
});
