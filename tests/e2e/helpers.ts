import { expect, type Page } from '@playwright/test';

export const PASSWORD = 'correct-horse-battery';

export async function signUpAndOnboard(page: Page, email: string) {
  await page.goto('/login');
  await page.getByRole('button', { name: 'Создать аккаунт' }).click();
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Пароль').fill(PASSWORD);
  await page.locator('button[type=submit]').click();
  await expect(page).toHaveURL(/\/onboarding/);
  // step through the wizard keeping the neutral defaults (09–18, prep 60, gym Tue/Thu 21–22)
  for (let i = 0; i < 5; i++) await page.getByRole('button', { name: 'Дальше' }).click();
  await expect(page.getByText('Вот твой базовый распорядок')).toBeVisible();
  await page.getByRole('button', { name: 'Сохранить и построить план' }).click();
  await expect(page).toHaveURL(/\/today/);
}

export async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, 'horizontal overflow in px').toBeLessThanOrEqual(1);
}
