import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

/** Load .env.local / .env for CLI scripts (Next.js loads them itself for the app). */
export function loadEnv(): void {
  for (const f of ['.env.local', '.env']) {
    const p = resolve(process.cwd(), f);
    if (existsSync(p)) {
      try {
        process.loadEnvFile(p);
      } catch {
        // ignore malformed optional files
      }
    }
  }
}
