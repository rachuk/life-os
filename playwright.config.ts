import { defineConfig, devices } from '@playwright/test';

/**
 * E2E against an isolated dev server (port 3100, database lifeos_e2e, frozen clock
 * "Tuesday 3 Nov 2026 17:50 Lisbon") so time-dependent flows like «Нужно поработать» are deterministic.
 */
const E2E_DB = process.env.E2E_DATABASE_URL ?? 'postgres://vik@localhost:5432/lifeos_e2e';
const PORT = 3100;

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  globalSetup: './tests/e2e/global-setup.ts',
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure', locale: 'ru-RU', timezoneId: 'Europe/Lisbon' },
  projects: [
    { name: 'iphone', use: { ...devices['iPhone 13'], browserName: 'chromium' } },
    { name: 'desktop', use: { viewport: { width: 1280, height: 860 } } },
  ],
  webServer: {
    command: `pnpm next dev --port ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      NEXT_DIST_DIR: '.next-e2e',
      DATABASE_URL: E2E_DB,
      APP_URL: `http://localhost:${PORT}`,
      SIGNUP_MODE: 'open',
      LIFEOS_FAKE_NOW: '2026-11-03T17:50:00+00:00',
      MEDIA_SIGNING_SECRET: 'e2e-media-secret',
      CRON_SECRET: 'e2e-cron-secret',
      STORAGE_DIR: './data/e2e-media',
      TELEGRAM_BOT_TOKEN: '',
      AI_LLM_BASE_URL: '',
      AI_TRANSCRIBE_BASE_URL: '',
      VAPID_PUBLIC_KEY: '',
      VAPID_PRIVATE_KEY: '',
    },
  },
});
