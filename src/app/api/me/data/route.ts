import { cookies } from 'next/headers';
import { z } from 'zod';
import { SESSION_COOKIE } from '@/server/auth/session';
import { readJson, userRoute } from '@/server/http';
import { deleteAllUserData } from '@/server/services/dataRights';

/**
 * DELETE {confirm: "УДАЛИТЬ"}: removes private files and every row of this user (cascade),
 * then clears the session cookie. Database backups are not rewritten; they age out per the
 * server's backup retention (documented in services/dataRights.ts and shown in the UI).
 */
export const DELETE = userRoute(async ({ req, user }) => {
  const { confirm } = await readJson(req, z.object({ confirm: z.string().max(40) }));
  const res = await deleteAllUserData(user.id, confirm.trim());
  (await cookies()).delete(SESSION_COOKIE);
  return { ok: true, filesDeleted: res.filesDeleted, message: 'Все данные и файлы удалены.' };
});
