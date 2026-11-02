import { z } from 'zod';
import { isLocalDate, isLocalTime, localTimeOf } from '@/domain/time';
import { AppError, notFound, param, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { createManualEvent, suggestTaskSlot } from '@/server/services/planning';

const schema = z.object({
  date: z.string().refine(isLocalDate),
  startTime: z.string().refine(isLocalTime).nullable().optional(),
  durationMinutes: z.number().int().min(5).max(600).default(30),
  suggestOnly: z.boolean().default(false),
});

/** Put a task into the plan: explicit time or the nearest free slot (no silent placement). */
export const POST = userRoute(async ({ req, user, params }) => {
  const input = await readJson(req, schema);
  const id = param(params, 'id');
  return inUser(user.id, async (tx, ctx) => {
    const [task] = await tx<{ id: string; title: string; estimatedMinutes: number | null }[]>`
      select id, title, estimated_minutes from tasks where id = ${id} and user_id = ${user.id}`;
    if (!task) throw notFound('Задача');
    const duration = task.estimatedMinutes ?? input.durationMinutes;
    let start = input.startTime ?? null;
    if (!start) {
      const slot = await suggestTaskSlot(tx, ctx, now(), input.date, duration);
      if (!slot) throw new AppError('NO_SLOT', 'На этот день нет свободного окна — выбери время вручную или другой день', 422);
      start = localTimeOf(slot.startAt, ctx.tz);
      if (input.suggestOnly) return { suggestion: { date: input.date, startTime: start, durationMinutes: duration } };
    }
    return createManualEvent(tx, ctx, now(), { date: input.date, startTime: start, durationMinutes: duration, title: task.title, kind: 'task', priorityClass: 'flexible', taskId: task.id });
  });
});
