import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve } from 'node:path';
import { env } from '../env';

/**
 * Private file storage on local disk (outside /public). Files are only ever served through the
 * authenticated, signed /api/media route. Swap for an S3-compatible driver later via this module.
 */
function root(): string {
  return resolve(/*turbopackIgnore: true*/ process.cwd(), env().STORAGE_DIR);
}

function safePath(rel: string): string {
  const full = normalize(join(/*turbopackIgnore: true*/ root(), rel));
  if (!full.startsWith(root())) throw new Error('invalid storage path');
  return full;
}

export async function putStoredFile(rel: string, data: Buffer): Promise<void> {
  const p = safePath(rel);
  await mkdir(dirname(p), { recursive: true, mode: 0o700 });
  await writeFile(p, data, { mode: 0o600 });
}

export async function getStoredFile(rel: string): Promise<Buffer> {
  return readFile(safePath(rel));
}

export async function deleteStoredFile(rel: string): Promise<void> {
  await rm(safePath(rel), { force: true });
}

export async function deleteUserFiles(userId: string): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(userId)) throw new Error('invalid user id');
  await rm(safePath(userId), { recursive: true, force: true });
}
