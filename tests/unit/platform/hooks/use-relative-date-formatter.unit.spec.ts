import { describe, expect, it } from 'vitest';

import { formatHydrationSafeRelativeDate } from '@/platform/hooks/use-relative-date-formatter';

describe('hydration-safe relative date formatting', () => {
  const baseDate = new Date('2026-09-01T03:00:30.000Z');
  const targetDate = new Date('2026-09-01T03:00:00.000Z');

  it('uses deterministic absolute text before hydration', () => {
    expect(
      formatHydrationSafeRelativeDate(targetDate, {
        baseDate,
        hydrated: false,
        locale: 'en',
      })
    ).toBe('2026-09-01T03:00:00.000Z');
  });

  it('uses localized relative text after hydration', () => {
    expect(
      formatHydrationSafeRelativeDate(targetDate, {
        baseDate,
        hydrated: true,
        locale: 'en',
      })
    ).toBe('30 seconds ago');
  });

  it('keeps invalid dates empty before and after hydration', () => {
    const invalidDate = new Date(Number.NaN);

    expect(
      formatHydrationSafeRelativeDate(invalidDate, { hydrated: false })
    ).toBe('');
    expect(
      formatHydrationSafeRelativeDate(invalidDate, { hydrated: true })
    ).toBe('');
  });
});
