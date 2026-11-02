import { AppError, userRoute } from '@/server/http';
import { inUser, now } from '@/server/context';
import { CSV_TABLES, exportFileName, exportUserData, healthMeasurementsCsv } from '@/server/services/dataRights';

/**
 * Personal export (PRD §19.1) as a download: full JSON of the user's rows (media as metadata),
 * or ?format=csv&table=health_measurements.
 */
export const GET = userRoute(async ({ user, url }) => {
  const t = now();
  const tz = await inUser(user.id, async (_tx, ctx) => ctx.tz);
  const format = url.searchParams.get('format') ?? 'json';
  const headers = (type: string, name: string) => ({
    'Content-Type': type,
    'Content-Disposition': `attachment; filename="${name}"`,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  if (format === 'csv') {
    const table = url.searchParams.get('table');
    if (!table || !(CSV_TABLES as readonly string[]).includes(table)) {
      throw new AppError('UNSUPPORTED_TABLE', 'CSV доступен для таблицы health_measurements', 422);
    }
    const csv = await healthMeasurementsCsv(user.id);
    return new Response(csv, { headers: headers('text/csv; charset=utf-8', exportFileName(t, tz, 'csv', '-health')) });
  }
  if (format !== 'json') throw new AppError('UNSUPPORTED_FORMAT', 'Формат: json или csv', 422);
  const bundle = await exportUserData(user.id, t);
  return new Response(JSON.stringify(bundle, null, 2), { headers: headers('application/json; charset=utf-8', exportFileName(t, tz, 'json')) });
});
