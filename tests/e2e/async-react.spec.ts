/* oxlint-disable vitest/no-conditional-in-test -- The instrumentation mirrors the browser API overload and optional test probe. */

import { expect, test } from '@tests/e2e/utils';
import { ADMIN_FILE, USER_FILE } from '@tests/e2e/utils/constants';

import { DEFAULT_LANGUAGE_KEY } from '@/platform/lib/i18n/constants';

import locales from '@/app/i18n';

const t = locales[DEFAULT_LANGUAGE_KEY];

test.describe('Async React search', { tag: '@demo' }, () => {
  test.use({ storageState: ADMIN_FILE });

  test('manager search typing remains urgent while navigation commits', async ({
    page,
  }) => {
    await page.to('/manager/books');
    const searchInput = page.getByPlaceholder(
      t.components.searchInput.placeholder
    );
    await expect(searchInput.locator('..')).toHaveAttribute(
      'data-hydrated',
      'true'
    );

    await searchInput.fill('The Hobbit');
    await expect(searchInput).toHaveValue('The Hobbit');
    await expect(page).toHaveURL(/searchTerm=The(?:\+|%20)Hobbit/);
  });
});

test.describe('Async React navigation', { tag: '@demo' }, () => {
  test.use({ storageState: USER_FILE });

  test('book grid navigation invokes the typed native view transition', async ({
    page,
  }) => {
    await page.to('/app/books');
    const bookLink = page.locator('a[href^="/app/books/"]').first();
    await expect(bookLink).toHaveAttribute('data-hydrated', 'true');
    const href = await bookLink.evaluate(
      (element: HTMLAnchorElement) => element.pathname
    );
    expect(href).toMatch(/^\/app\/books\//);

    const supportsViewTransitions = await page.evaluate(
      () => typeof document.startViewTransition === 'function'
    );
    expect(supportsViewTransitions).toBe(true);

    const transitionProbeInstalled = await page.evaluate(() => {
      const transitionTypes: string[][] = [];
      const originalStartViewTransition =
        document.startViewTransition.bind(document);
      const startViewTransition = (
        callbackOptions: Parameters<Document['startViewTransition']>[0]
      ) => {
        transitionTypes.push(
          typeof callbackOptions === 'object'
            ? [...(callbackOptions.types ?? [])]
            : []
        );
        return originalStartViewTransition(callbackOptions);
      };
      document.startViewTransition = startViewTransition;
      Object.assign(window, {
        __testNavigationSentinel: true,
        __testViewTransitionTypes: transitionTypes,
      });
      return document.startViewTransition === startViewTransition;
    });
    expect(transitionProbeInstalled).toBe(true);

    await bookLink.click();

    await expect(page).toHaveURL(new RegExp(`${href}/?$`));
    await expect
      .poll(() =>
        page.evaluate(
          () =>
            (
              window as Window & {
                __testViewTransitionTypes?: string[][];
              }
            ).__testViewTransitionTypes?.length ?? 0
        )
      )
      .toBeGreaterThan(0);
    const transitionTypes = await page.evaluate(() => {
      const testWindow = window as Window & {
        __testNavigationSentinel?: boolean;
        __testViewTransitionTypes?: string[][];
      };
      return {
        sameDocument: testWindow.__testNavigationSentinel === true,
        types: testWindow.__testViewTransitionTypes ?? [],
      };
    });
    expect(transitionTypes.sameDocument).toBe(true);
    expect(transitionTypes.types).toContainEqual(['book-cover']);
  });

  test('book navigation succeeds with reduced motion enabled', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.to('/app/books');
    const bookLink = page.locator('a[href^="/app/books/"]').first();
    await expect(bookLink).toHaveAttribute('data-hydrated', 'true');
    const href = await bookLink.evaluate(
      (element: HTMLAnchorElement) => element.pathname
    );
    expect(href).toMatch(/^\/app\/books\//);
    expect(
      await page.evaluate(
        () => window.matchMedia('(prefers-reduced-motion: reduce)').matches
      )
    ).toBe(true);

    await bookLink.click();

    await expect(page).toHaveURL(new RegExp(`${href}/?$`));
  });
});
