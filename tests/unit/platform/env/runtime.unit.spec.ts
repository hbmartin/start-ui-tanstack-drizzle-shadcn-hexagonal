import { describe, expect, it } from 'vitest';

import { isProdRuntimeEnvironment } from '@/platform/env/runtime';

describe('runtime environment classification', () => {
  it('keeps production guards enabled for staging production builds', () => {
    expect(isProdRuntimeEnvironment({ NODE_ENV: 'staging', PROD: true })).toBe(
      true
    );
  });

  it('allows only explicit development and test environments to downgrade', () => {
    expect(
      isProdRuntimeEnvironment({ NODE_ENV: 'development', PROD: true })
    ).toBe(false);
    expect(isProdRuntimeEnvironment({ NODE_ENV: 'test', PROD: true })).toBe(
      false
    );
  });
});
