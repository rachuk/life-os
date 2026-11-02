import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { withUser } from '../db';

/**
 * One pending conversational step per chat, stored in telegram_connections.pending_state:
 * an extra-work preview waiting for «Подтвердить», a photo waiting for a typed number, etc.
 * A newer step replaces an older one; stale steps expire.
 */

const at = z.string();
const metric = z.enum(['weight', 'steps']);

export const pendingStateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('extra_work'),
    nonce: z.string(),
    messageId: z.number().int(),
    request: z.object({
      date: z.string(),
      startMode: z.enum(['after_work', 'now', 'at']),
      startTime: z.string().nullable(),
      durationMinutes: z.number().int(),
      reason: z.string().nullable(),
    }),
    eventRef: z.string(),
    expectedPlanVersion: z.number().int(),
    fingerprint: z.string(),
    requiresAck: z.boolean(),
    at,
  }),
  z.object({ kind: z.literal('await_value'), mediaId: z.string().uuid(), metric, at }),
  z.object({
    kind: z.literal('photo_value'),
    mediaId: z.string().uuid(),
    metric,
    value: z.number(),
    localDate: z.string().nullable(),
    interpretationId: z.string().uuid().nullable(),
    at,
  }),
  z.object({
    kind: z.literal('meal'),
    mediaId: z.string().uuid(),
    eventId: z.string().uuid().nullable(),
    slot: z.enum(['breakfast', 'lunch', 'dinner', 'snack', 'post_workout']),
    description: z.string().nullable(),
    interpretationId: z.string().uuid().nullable(),
    at,
  }),
]);
export type PendingState = z.infer<typeof pendingStateSchema>;

const TTL_MINUTES: Record<PendingState['kind'], number> = { extra_work: 30, await_value: 120, photo_value: 120, meal: 240 };

export function newNonce(): string {
  return randomBytes(6).toString('base64url');
}

export async function getPending(userId: string, nowMs = Date.now()): Promise<PendingState | null> {
  const [row] = await withUser(userId, (tx) => tx<{ pendingState: unknown }[]>`
    select pending_state from telegram_connections where user_id = ${userId}`);
  const parsed = pendingStateSchema.safeParse(row?.pendingState);
  if (!parsed.success) return null;
  const age = nowMs - Date.parse(parsed.data.at);
  if (!Number.isFinite(age) || age > TTL_MINUTES[parsed.data.kind] * 60_000) return null;
  return parsed.data;
}

export async function setPending(userId: string, state: PendingState | null): Promise<void> {
  await withUser(userId, (tx) => tx`
    update telegram_connections set pending_state = ${state ? tx.json(state as never) : null} where user_id = ${userId}`);
}

/** Clear only if the stored step is still the one we finished (a newer step is left alone). */
export async function clearPendingIf(userId: string, match: (s: PendingState) => boolean): Promise<void> {
  const cur = await getPending(userId, 0);
  if (cur && match(cur)) await setPending(userId, null);
}
