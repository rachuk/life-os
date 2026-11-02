import { existsSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

for (const f of ['.env.local', '.env']) {
  if (existsSync(f)) {
    try {
      process.loadEnvFile(f);
    } catch {
      /* optional */
    }
  }
}
const testDb = process.env.TEST_DATABASE_URL ?? 'postgres://localhost:5432/lifeos_test';

export default defineConfig({
  resolve: { tsconfigPaths: true },
  test: {
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 60000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDb,
      TEST_DATABASE_URL: testDb,
      APP_URL: 'http://localhost:3000',
      MEDIA_SIGNING_SECRET: 'test-media-secret',
      CRON_SECRET: 'test-cron-secret',
      STORAGE_DIR: './data/test-media',
      TELEGRAM_BOT_TOKEN: '',
      TELEGRAM_BOT_USERNAME: '',
      TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
      AI_LLM_BASE_URL: '',
      AI_LLM_API_KEY: '',
      AI_LLM_MODEL: '',
      AI_VISION_MODEL: '',
      AI_TRANSCRIBE_BASE_URL: '',
      AI_TRANSCRIBE_API_KEY: '',
    },
  },
});
