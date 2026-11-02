import type { DateTime } from 'luxon';
import { localDateOf } from '@/domain/time';
import { withSystem, withUser } from '../db';
import { AppError } from '../http';
import { deleteStoredFile, deleteUserFiles } from '../storage/files';
import { audit } from './audit';

/**
 * Data rights (PRD §16 details, §19.1): personal export (JSON, CSV for measurements) and
 * confirmed deletion of all personal data and private files.
 *
 * Backups: deletion removes rows and files from the live system immediately. Database backups
 * (pg_dump on the server) are NOT edited — deleted data disappears from them only when those
 * backups age out according to the backup retention policy of the deployment. We say this
 * honestly in the UI instead of promising instant erasure everywhere.
 */

const IDENT = /^[a-z_][a-z0-9_]*$/;
/** Columns that are secrets/internal and never leave the server, even to the owner. */
const REDACT: Record<string, string[]> = {
  pushSubscriptions: ['p256dh', 'auth'],
  mediaAssets: ['storagePath'],
};

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

export interface ExportBundle {
  format: 'lifeos-export';
  version: 1;
  exportedAt: string;
  timezone: string | null;
  account: Record<string, unknown> | null;
  notes: string[];
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
}

/**
 * Every table the user role can read that has a user_id column — discovered from the catalog,
 * so tables added by later migrations are exported too. RLS limits rows to the owner, and the
 * query also filters by user_id explicitly.
 */
export async function exportUserData(userId: string, now: DateTime): Promise<ExportBundle> {
  return withUser(userId, async (tx) => {
    const tables = await tx<{ tableName: string }[]>`
      select c.relname as table_name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace and n.nspname = 'public'
      join pg_attribute a on a.attrelid = c.oid and a.attname = 'user_id' and not a.attisdropped
      where c.relkind in ('r', 'p') and has_table_privilege(c.oid, 'SELECT')
      order by c.relname`;
    const out: Record<string, Record<string, unknown>[]> = {};
    const counts: Record<string, number> = {};
    for (const { tableName } of tables) {
      if (!IDENT.test(tableName)) continue;
      const rows = (await tx.unsafe(`select * from "${tableName}" where user_id = $1`, [userId])) as unknown as Record<string, unknown>[];
      const key = camel(tableName);
      const drop = REDACT[key] ?? [];
      out[key] = rows.map((r) => {
        if (!drop.length) return { ...r };
        const copy: Record<string, unknown> = { ...r };
        for (const d of drop) if (d in copy) delete copy[d];
        return copy;
      });
      counts[key] = rows.length;
    }
    const [account] = await tx<Record<string, unknown>[]>`select id, email, display_name, role, created_at from users where id = ${userId}`;
    const [profile] = await tx<{ timezone: string }[]>`select timezone from profiles where user_id = ${userId}`;
    await audit(tx, userId, 'account', userId, 'data_exported', { format: 'json', tables: Object.keys(out).length });
    return {
      format: 'lifeos-export',
      version: 1,
      exportedAt: now.toISO()!,
      timezone: profile?.timezone ?? null,
      account: account ?? null,
      notes: [
        'Время хранится в UTC (ISO 8601); localDate — календарная дата в твоём часовом поясе.',
        'Медиа (фото, скриншоты, голос) включены только как метаданные: сами файлы в JSON не входят, их можно скачать по одному в приложении.',
        'Не входят: пароль, сессии и ключи push-подписок — это секреты, а не личные данные.',
        'Фонд наград виртуальный: банковских реквизитов система не хранит.',
      ],
      counts,
      tables: out,
    };
  });
}

function csvCell(v: unknown): string {
  if (v === null || v === undefined) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  // spreadsheet formula injection guard
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const CSV_TABLES = ['health_measurements'] as const;

export async function healthMeasurementsCsv(userId: string): Promise<string> {
  const rows = await withUser(userId, (tx) => tx<Record<string, unknown>[]>`
    select local_date, metric_type, value, unit, measured_at, source_type, ai_confidence, user_confirmed_at, notes
    from health_measurements where user_id = ${userId} order by local_date, measured_at`);
  const cols = ['local_date', 'metric_type', 'value', 'unit', 'measured_at', 'source_type', 'ai_confidence', 'user_confirmed_at', 'notes'];
  const lines = [cols.join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[camel(c)])).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}

export function exportFileName(now: DateTime, tz: string, ext: string, suffix = ''): string {
  return `lifeos-export${suffix}-${localDateOf(now, tz)}.${ext}`;
}

export const DELETE_CONFIRMATION = 'УДАЛИТЬ';

/**
 * Delete all personal data: private files first (retry-safe: if this fails nothing in the DB is
 * touched), then the user row — every user table cascades from users(id). System logs that keep
 * a nullable user reference (telegram_events) and the login throttle keyed by email are removed
 * explicitly. Nothing is audited afterwards: there is no user left to attribute it to.
 */
export async function deleteAllUserData(userId: string, confirm: string): Promise<{ filesDeleted: number }> {
  if (confirm !== DELETE_CONFIRMATION) throw new AppError('CONFIRMATION_REQUIRED', `Для удаления введи слово ${DELETE_CONFIRMATION}`, 422);
  const media = await withUser(userId, (tx) => tx<{ storagePath: string }[]>`select storage_path from media_assets where user_id = ${userId}`);
  for (const m of media) await deleteStoredFile(m.storagePath);
  await deleteUserFiles(userId);
  await withSystem(async (tx) => {
    const [u] = await tx<{ emailNormalized: string }[]>`select email_normalized from users where id = ${userId} for update`;
    if (!u) return;
    await tx`delete from telegram_events where user_id = ${userId}`;
    await tx`delete from auth_attempts where key = ${`email:${u.emailNormalized}`}`;
    await tx`delete from users where id = ${userId}`;
  });
  return { filesDeleted: media.length };
}
