import * as Sentry from '@sentry/cloudflare';
import { describe, expect, it } from 'vitest';

import { initializeCloudflareSentryIsolation } from '@/runtime/cloudflare/sentry-request';

describe('Cloudflare Sentry runtime compatibility', () => {
  it('loads node:async_hooks through the verified workerd compatibility flag', () => {
    expect(initializeCloudflareSentryIsolation(Sentry)).toBe(true);
  });
});
