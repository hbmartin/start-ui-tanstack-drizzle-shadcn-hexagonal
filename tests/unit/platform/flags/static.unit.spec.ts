import { describe, expect, it } from 'vitest';

import { createStaticFlags } from '@/platform/flags';

describe('createStaticFlags', () => {
  it('resolves flags from the static defaults', () => {
    const flags = createStaticFlags({ beta: true, legacy: false });

    expect(flags.isEnabled('beta')).toBe(true);
    expect(flags.isEnabled('legacy')).toBe(false);
  });

  it('resolves unknown flags to false like the no-op adapter', () => {
    const flags = createStaticFlags({});

    expect(flags.isEnabled('unknown')).toBe(false);
  });
});
