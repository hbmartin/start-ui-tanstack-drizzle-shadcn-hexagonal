/* oxlint-disable vitest/no-conditional-in-test -- E2E retry logic handles browser navigation aborts while preserving assertions. */

import { expect, test } from '@tests/e2e/utils';
import { ADMIN_EMAIL, ADMIN_FILE } from '@tests/e2e/utils/constants';

import { DEFAULT_LANGUAGE_KEY } from '@/platform/lib/i18n/constants';

import locales from '@/app/i18n';

const t = locales[DEFAULT_LANGUAGE_KEY];

test.describe('Protected route navigation', { tag: '@demo' }, () => {
  test('returns to a protected deep link after login with search intact', async ({
    page,
  }) => {
    await page.goto('/manager/books?searchTerm=Hobbit', {
      waitUntil: 'commit',
    });

    await expect(page).toHaveURL(/\/login\?/);
    expect(new URL(page.url()).searchParams.get('redirect')).toBe(
      '/manager/books?searchTerm=Hobbit'
    );

    await page.login({ email: ADMIN_EMAIL });

    await expect(page).toHaveURL(/\/manager\/books\?searchTerm=Hobbit$/);
    await expect(page.getByTestId('layout-manager')).toHaveAttribute(
      'data-hydrated',
      'true'
    );
    await expect(page.getByRole('link', { name: 'The Hobbit' })).toBeVisible();
    await expect(page.getByText('1 results for "Hobbit"')).toBeVisible();
  });
});

test.describe('Protected route navigation as manager', () => {
  test.use({ storageState: ADMIN_FILE });

  test(
    'opens and refreshes a nested book route from a direct URL',
    { tag: '@demo' },
    async ({ page }) => {
      await page.goto('/manager/books?searchTerm=Hobbit', {
        waitUntil: 'commit',
      });

      const bookLink = page.getByRole('link', { name: 'The Hobbit' });
      await expect(bookLink).toBeVisible();
      await expect(page.getByTestId('layout-manager')).toHaveAttribute(
        'data-hydrated',
        'true'
      );
      const href = await bookLink.getAttribute('href');
      expect(href).toMatch(/^\/manager\/books\/[^/]+\/?$/);

      await expect(async () => {
        try {
          await page.goto(href ?? '/manager/books', { waitUntil: 'commit' });
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes('NS_BINDING_ABORTED')
          ) {
            throw error;
          }
        }

        expect(new URL(page.url()).pathname).toMatch(
          /^\/manager\/books\/[^/]+\/?$/
        );
      }).toPass({ timeout: 10_000 });
      const deepLink = new URL(page.url()).pathname;

      await expect(page.getByText('The Hobbit - J.R.R. Tolkien')).toBeVisible();
      await expect(
        page.getByText('J.R.R. Tolkien', { exact: true })
      ).toBeVisible();
      await expect(page.getByTestId('layout-manager')).toHaveAttribute(
        'data-hydrated',
        'true'
      );

      await page.reload({ waitUntil: 'commit' });

      await expect(page).toHaveURL(new RegExp(`${deepLink}/?$`));
      await expect(page.getByTestId('layout-manager')).toHaveAttribute(
        'data-hydrated',
        'true'
      );
      await expect(page.getByText('The Hobbit - J.R.R. Tolkien')).toBeVisible();
    }
  );

  test('preserves manager list search params across reloads', async ({
    page,
  }) => {
    const encodedEmail = encodeURIComponent(ADMIN_EMAIL);
    const escapedEncodedEmail = encodedEmail.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&'
    );

    await page.goto(`/manager/users?searchTerm=${encodedEmail}`, {
      waitUntil: 'commit',
    });

    await expect(
      page.getByPlaceholder(t.components.searchInput.placeholder)
    ).toHaveValue(ADMIN_EMAIL);
    await expect(page.getByText(ADMIN_EMAIL, { exact: true })).toBeVisible();
    await expect(
      page.getByText(`1 results for "${ADMIN_EMAIL}"`)
    ).toBeVisible();
    await expect(page.getByTestId('layout-manager')).toHaveAttribute(
      'data-hydrated',
      'true'
    );

    await page.reload({ waitUntil: 'commit' });

    await expect(page).toHaveURL(
      new RegExp(`/manager/users\\?searchTerm=${escapedEncodedEmail}$`)
    );
    await expect(page.getByTestId('layout-manager')).toHaveAttribute(
      'data-hydrated',
      'true'
    );
    await expect(
      page.getByPlaceholder(t.components.searchInput.placeholder)
    ).toHaveValue(ADMIN_EMAIL);
    await expect(page.getByText(ADMIN_EMAIL, { exact: true })).toBeVisible();
  });
});
