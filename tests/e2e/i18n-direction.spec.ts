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

  const languageSelect = page.getByRole('combobox', { name: 'Language' });
  await expect(languageSelect).toHaveAttribute('data-hydrated', 'true');
  await languageSelect.click();
  await page.getByRole('option').filter({ hasText: 'Arabic' }).click();
  await expectDocumentDirection(page, 'ar', 'rtl');

  const arabicLanguageSelect = page.getByRole('combobox', { name: 'لغة' });
  await expect(arabicLanguageSelect).toHaveAttribute('data-hydrated', 'true');
  await arabicLanguageSelect.click();
  await page.getByRole('option').filter({ hasText: 'English' }).click();
  await expectDocumentDirection(page, 'en', 'ltr');
});
