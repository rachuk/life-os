import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { privacySchema, updatePrivacy } from '@/server/services/profile';
import { patchOf } from '@/lib/patch';

export const PATCH = userRoute(async ({ req, user }) => {
  const patch = await readJson(req, patchOf(privacySchema));
  return inUser(user.id, async (tx) => ({ privacy: await updatePrivacy(tx, user.id, patch) }));
});
