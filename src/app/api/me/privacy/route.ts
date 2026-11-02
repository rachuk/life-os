import { readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { privacySchema, updatePrivacy } from '@/server/services/profile';

export const PATCH = userRoute(async ({ req, user }) => {
  const patch = await readJson(req, privacySchema.partial());
  return inUser(user.id, async (tx) => ({ privacy: await updatePrivacy(tx, user.id, patch) }));
});
