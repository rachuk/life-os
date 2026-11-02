import { z } from 'zod';
import { isLocalDate } from '@/domain/time';
import { param, readJson, userRoute } from '@/server/http';
import { inUser } from '@/server/context';
import { completeTask, serializeTask } from '@/server/services/tasks';

const schema = z.object({
  followUp: z.object({ title: z.string().trim().min(1).max(300), date: z.string().refine(isLocalDate), waitingFor: z.string().max(200).nullable().optional() }).nullable().optional(),
});

/** TASK-04: complete + optional "проверить ответ" follow-up. */
export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, schema);
  return inUser(user.id, async (tx, ctx) => {
    const r = await completeTask(tx, ctx, param(params, 'id'), { followUp: input.followUp ?? null });
    return { task: serializeTask(r.task), followUp: r.followUp ? serializeTask(r.followUp) : null };
  });
});
