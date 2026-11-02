import type { DateTime } from 'luxon';
import { withSystem } from '../db';
import { deleteStoredFile } from '../storage/files';

/** Deletes media whose retention period has passed (voice after processing, meal photos after N days). */
export async function purgeExpiredMedia(now: DateTime): Promise<number> {
  const expired = await withSystem((tx) => tx<{ id: string; storagePath: string }[]>`
    select id, storage_path from media_assets where retention_until is not null and retention_until < ${now.toJSDate()} limit 200`);
  for (const m of expired) {
    await deleteStoredFile(m.storagePath).catch(() => {});
    await withSystem((tx) => tx`delete from media_assets where id = ${m.id}`);
  }
  return expired.length;
}
