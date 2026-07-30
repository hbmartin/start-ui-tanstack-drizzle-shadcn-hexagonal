import { afterEach, describe, expect, it } from 'vitest';

import {
  getBrandAppName,
  setBrandAppName,
} from '@/platform/lib/get-page-title';

import {
  adopterConfig,
  configureAdopter,
  createAdopterFlags,
} from '@/app/adopter';

describe('adopter zone', () => {
  afterEach(() => {
    setBrandAppName('Start UI');
  });

  it('applies the adopter app name at boot', () => {
    setBrandAppName('something-else');

    configureAdopter();

    expect(getBrandAppName()).toBe(adopterConfig.appName);
  });

  it('exposes a brand mark for the platform Logo', () => {
    expect(typeof adopterConfig.brand.mark).toBe('function');
  });

  it('sources router flags from the adopter feature-flag defaults', () => {
    const flags = createAdopterFlags();

    for (const [flag, enabled] of Object.entries(adopterConfig.featureFlags)) {
      expect(flags.isEnabled(flag)).toBe(enabled);
    }
    expect(flags.isEnabled('flag-that-does-not-exist')).toBe(false);
  });
});
