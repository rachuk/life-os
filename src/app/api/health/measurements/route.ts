import { AppError, readJson, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { addDays, isLocalDate, localDateOf } from '@/domain/time';
import type { MetricType } from '@/domain/types';
import { addMeasurement, listMeasurements, measurementInputSchema, METRIC_RULES, serializeMeasurement } from '@/server/services/health';

/** Measurements for a range (optionally one metric). */
export const GET = userRoute(async ({ user, url }) =>
  inUser(user.id, async (tx, ctx) => {
    const today = localDateOf(now(), ctx.tz);
    const to = url.searchParams.get('to') ?? today;
    const from = url.searchParams.get('from') ?? addDays(to, -29);
    const metric = url.searchParams.get('metric');
    if (!isLocalDate(from) || !isLocalDate(to)) throw new AppError('BAD_DATE', 'from/to: YYYY-MM-DD', 400);
    if (metric && !(metric in METRIC_RULES)) throw new AppError('BAD_METRIC', 'Неизвестный показатель', 400);
    const rows = await listMeasurements(tx, ctx.userId, (metric as MetricType | null) ?? null, from, to);
    return { from, to, measurements: rows.map(serializeMeasurement) };
  }),
);

/**
 * Add a value with date + source (HEALTH-01). For daily metrics a second value on the same date
 * answers 409 DUPLICATE_FOR_DATE with the existing value; the client asks «Заменить?» and resends
 * with replace: true.
 */
export const POST = userRoute(async ({ req, user }) => {
  const input = await readJson(req, measurementInputSchema);
  return inUser(user.id, async (tx, ctx) => ({ measurement: serializeMeasurement(await addMeasurement(tx, ctx, now(), input)) }));
});
