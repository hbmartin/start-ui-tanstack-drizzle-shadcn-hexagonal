import type { Page } from '@playwright/test';
import { expect, test } from '@tests/e2e/utils';

const expectDocumentDirection = async (
  page: Page,
  language: string,
  direction: 'ltr' | 'rtl'
) => {
  const documentElement = page.locator('html');
  await expect(documentElement).toHaveAttribute('lang', language);
  await expect(documentElement).toHaveAttribute('dir', direction);
  await expect(documentElement).toHaveCSS('direction', direction);
};

test('switches the hydrated document between LTR and RTL', async ({ page }) => {
  await page.to('/login');
  await expectDocumentDirection(page, 'en', 'ltr');

  await page.getByRole('combobox', { name: 'Language' }).click();
  await page.getByRole('option').filter({ hasText: 'Arabic' }).click();
  await expectDocumentDirection(page, 'ar', 'rtl');

  await page.getByRole('combobox', { name: 'لغة' }).click();
  await page.getByRole('option').filter({ hasText: 'English' }).click();
  await expectDocumentDirection(page, 'en', 'ltr');
});
