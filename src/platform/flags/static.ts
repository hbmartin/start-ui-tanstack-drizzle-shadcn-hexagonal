import type { FlagsAdapter } from './types';

/**
 * Flags resolved from a static default map (e.g. the adopter config).
 * Unknown flags resolve to `false`, matching the no-op adapter.
 */
export const createStaticFlags = (
  defaults: Readonly<Record<string, boolean>>
): FlagsAdapter => ({
  isEnabled: (flag) => defaults[flag] ?? false,
});
