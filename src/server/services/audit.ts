import type { Tx } from '../db';

/** Audit trail without attachment contents or secrets (PRD §19.2). */
export async function audit(
  tx: Tx,
  userId: string,
  entityType: string,
  entityId: string | null,
  action: string,
  safeDiff: unknown = {},
  source = 'web',
): Promise<void> {
  await tx`insert into audit_events (user_id, entity_type, entity_id, action, safe_diff_json, source)
           values (${userId}, ${entityType}, ${entityId}, ${action}, ${tx.json((safeDiff ?? {}) as never)}, ${source})`;
}
