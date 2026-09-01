import { describe, expect, it } from 'vitest';

import { isCapabilityRouteEnabled } from '@/app/capabilities/is-capability-route-enabled';

describe('capability route selection', () => {
  it.each([
    '/api/upload',
    '/api/upload/',
    '/app/books',
    '/app/books/123',
    '/manager/books',
    '/manager/books/new',
  ])('disables the demo route %s for core', (pathname) => {
    expect(isCapabilityRouteEnabled(pathname, () => false)).toBe(false);
  });

  it('keeps core routes available and demo routes available in demo', () => {
    expect(isCapabilityRouteEnabled('/app/profile', () => false)).toBe(true);
    expect(isCapabilityRouteEnabled('/api/upload', () => true)).toBe(true);
  });
});
