import { useCallback } from 'react';

import { formatRelativeDate } from '@/platform/lib/temporal/date-time';

import { useHydrated } from './use-hydrated';

type HydrationSafeRelativeDateOptions = {
  baseDate?: Date;
  hydrated: boolean;
  locale?: string;
};

export const formatHydrationSafeRelativeDate = (
  date: Date,
  options: HydrationSafeRelativeDateOptions
) => {
  if (!options.hydrated) {
    return Number.isNaN(date.getTime()) ? '' : date.toISOString();
  }

  return formatRelativeDate(date, {
    baseDate: options.baseDate,
    locale: options.locale,
  });
};

/**
 * Keeps the server and first client render deterministic, then switches to
 * localized relative copy after hydration. Call once per component and reuse
 * the returned formatter inside lists.
 */
export const useRelativeDateFormatter = (locale?: string) => {
  const hydrated = useHydrated();

  return useCallback(
    (date: Date) => formatHydrationSafeRelativeDate(date, { hydrated, locale }),
    [hydrated, locale]
  );
};
