import { describe, expect, it } from 'vitest';

import { shouldEnableSentryBuildPlugin } from '../../../scripts/sentry-build-plugin';

const configuredEnvironment = {
  authToken: 'hostile-real-token-sentinel',
  disabled: false,
  dsn: 'https://public@example.invalid/1',
  organization: 'real-organization-sentinel',
  project: 'real-project-sentinel',
} as const;

describe('shouldEnableSentryBuildPlugin', () => {
  it('enables uploads only when every explicit input is present', () => {
    expect(shouldEnableSentryBuildPlugin(configuredEnvironment)).toBe(true);
    expect(
      shouldEnableSentryBuildPlugin({
        ...configuredEnvironment,
        authToken: undefined,
      })
    ).toBe(false);
  });

  it('keeps verification builds offline even if credential sentinels exist', () => {
    expect(
      shouldEnableSentryBuildPlugin({
        ...configuredEnvironment,
        disabled: true,
      })
    ).toBe(false);
  });
});
