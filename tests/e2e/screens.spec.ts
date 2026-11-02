import { expect, test } from '@playwright/test';
import { noHorizontalScroll, signUpAndOnboard } from './helpers';

const SCREENS = [
  '/today',
  '/plan',
  '/plan?view=week',
  '/tasks',
  '/tasks?tab=waiting',
  '/health',
  '/health/meals',
  '/health/photo',
  '/shopping',
  '/workouts',
  '/review/evening',
  '/review/week',
  '/rewards',
  '/more',
  '/notifications',
  '/settings',
];

/** UX-01 / UX-02: every main screen renders real content, without errors or horizontal scrolling. */
test('all main screens render without errors or horizontal overflow', async ({ page }, info) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await signUpAndOnboard(page, `e2e-screens-${info.project.name}-${Date.now()}@test.local`);
  for (const path of SCREENS) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(400);
    await expect(page.locator('h1').first(), path).toBeVisible();
    await expect(page.getByText(/Что-то пошло не так|Не удалось загрузить|Application error/i), path).toHaveCount(0);
    await noHorizontalScroll(page);
  }
  expect(errors, errors.join('\n')).toEqual([]);
});

test('NT-07: without a Telegram token the settings honestly say «не настроен»', async ({ page }, info) => {
  await signUpAndOnboard(page, `e2e-tg-${info.project.name}-${Date.now()}@test.local`);
  await page.goto('/settings');
  await expect(page.getByText('Telegram-бот').first()).toBeVisible();
  await expect(page.getByText(/не настроен на сервере/i).first()).toBeVisible();
  const r = await page.request.post('/api/telegram/webhook', { data: { update_id: 1 } });
  expect(r.status()).toBe(503);
});
