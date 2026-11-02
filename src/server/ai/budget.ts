import type { Tx } from '../db';
import { withSystem } from '../db';
import { env } from '../env';
import { AIError } from './provider';

/** Per-user daily request cap for external AI calls (PRD §18.3). */
export async function assertAIBudget(userId: string): Promise<void> {
  const limit = env().AI_DAILY_REQUEST_LIMIT;
  const [r] = await withSystem((tx) => tx<{ n: number }[]>`
    select count(*)::int as n from external_api_usage where user_id = ${userId} and created_at > now() - interval '1 day'`);
  if ((r?.n ?? 0) >= limit) throw new AIError('BUDGET', 'Дневной лимит запросов к ИИ исчерпан — используй ручной ввод');
}

export async function recordAIUsage(userId: string, provider: string, operation: string, success: boolean, tx?: Tx): Promise<void> {
  const run = (t: Tx) => t`insert into external_api_usage (user_id, provider, operation, success) values (${userId}, ${provider}, ${operation}, ${success})`;
  if (tx) await run(tx);
  else await withSystem(run);
}
