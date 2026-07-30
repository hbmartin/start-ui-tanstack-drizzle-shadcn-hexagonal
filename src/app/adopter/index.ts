import { setBrandAppName } from '@/platform/lib/get-page-title';

import { createStaticFlags, type FlagsAdapter } from '@/platform/flags';

import { adopterConfig } from './adopter.config';

export { type AdopterConfig, adopterConfig } from './adopter.config';

/**
 * Boot hook: applies the adopter identity to platform seams that cannot
 * import this zone directly. Invoked once at module evaluation from
 * `src/router.tsx` (both SSR and client).
 */
export const configureAdopter = () => {
  setBrandAppName(adopterConfig.appName);
};

/** Router `flags` context sourced from the adopter zone's defaults. */
export const createAdopterFlags = (): FlagsAdapter =>
  createStaticFlags(adopterConfig.featureFlags);
