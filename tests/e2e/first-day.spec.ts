import { expect, test } from '@playwright/test';
import { noHorizontalScroll, signUpAndOnboard } from './helpers';

/**
 * PRD §21.7 «реальный первый день» (core part) at a frozen time: Tuesday 3 Nov 2026, 17:50 Lisbon.
 */
test('onboarding → capture → tasks → extra work preview/commit/undo', async ({ page }, info) => {
  const email = `e2e-${info.project.name}-${Date.now()}@test.local`;
  await signUpAndOnboard(page, email);

  // Сейчас at 17:50: work ends at 18:00 → "Завершил работу?"
  await expect(page.getByRole('heading', { name: 'Завершил работу?' })).toBeVisible();
  await noHorizontalScroll(page);

  // Quick capture: TASK-01
  await page.getByRole('button', { name: /Быстрый ввод/ }).filter({ visible: true }).first().click();
  await page.getByRole('textbox', { name: 'Текст' }).fill('напомни завтра написать брокеру, купить бананы');
  await page.getByRole('button', { name: 'Разобрать' }).click();
  await expect(page.getByText('Проверь и подтверди')).toBeVisible();
  await expect(page.getByLabel('Название').first()).toHaveValue(/брокеру/i);
  await page.getByRole('button', { name: 'Создать всё' }).click();
  await expect(page.getByText(/Готово: 2/)).toBeVisible();

  await page.goto('/tasks');
  await expect(page.getByText(/брокеру/i).first()).toBeVisible();
  await noHorizontalScroll(page);

  // Extra work: PL-04 preview, PL-05 commit, PL-08 undo
  await page.goto('/plan');
  await page.getByRole('button', { name: 'Нужно поработать' }).filter({ visible: true }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '+2 ч' }).click();
  await expect(dialog.getByText('18:00–20:00')).toBeVisible();
  await expect(dialog.getByText('Ужин').first()).toBeVisible(); // dinner moved inside its window
  await dialog.getByRole('button', { name: /Подтвердить/ }).click();
  await expect(page.getByText(/План перестроен/)).toBeVisible();
  await expect(page.getByText('Дополнительная работа').first()).toBeVisible();

  await page.getByRole('button', { name: 'Отменить' }).filter({ visible: true }).first().click();
  await expect(page.getByText(/отменены|Отменено/).first()).toBeVisible();
  await noHorizontalScroll(page);

  for (const path of ['/today', '/settings', '/notifications']) {
    await page.goto(path);
    await noHorizontalScroll(page);
  }
});

test('SEC-01 via API: another account cannot read or change my task', async ({ browser }, info) => {
  const a = await browser.newContext();
  const pa = await a.newPage();
  await signUpAndOnboard(pa, `e2e-a-${info.project.name}-${Date.now()}@test.local`);
  const created = await pa.request.post('/api/tasks', { data: { title: 'Секрет A', type: 'task', category: 'personal', priority: 'normal' }, headers: { origin: 'http://localhost:3100' } });
  expect(created.ok()).toBeTruthy();
  const taskId = (await created.json()).task.id as string;

  const b = await browser.newContext();
  const pb = await b.newPage();
  await signUpAndOnboard(pb, `e2e-b-${info.project.name}-${Date.now()}@test.local`);
  const list = await pb.request.get('/api/tasks?tab=all');
  expect(JSON.stringify(await list.json())).not.toContain('Секрет A');
  const patch = await pb.request.patch(`/api/tasks/${taskId}`, { data: { title: 'hacked' }, headers: { origin: 'http://localhost:3100' } });
  expect(patch.status()).toBe(404);
  const anon = await (await browser.newContext()).request.get('/api/tasks');
  expect(anon.status()).toBe(401);
  await a.close();
  await b.close();
});

test('CSRF: cross-origin mutation is rejected', async ({ page }, info) => {
  await signUpAndOnboard(page, `e2e-c-${info.project.name}-${Date.now()}@test.local`);
  const r = await page.request.post('/api/tasks', { data: { title: 'x' }, headers: { origin: 'https://evil.example' } });
  expect(r.status()).toBe(403);
});
