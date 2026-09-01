import { describe, expect, it } from 'vitest';

import { getPageTitle } from '@/platform/lib/get-page-title';

describe('getPageTitle', () => {
  it('omits the prefix separator when no title prefix is provided', () => {
    expect(getPageTitle('Home', '', 'Acme')).toBe('Home | Acme');
    expect(getPageTitle(undefined, '', 'Acme')).toBe('Acme');
  });

  it('adds a separator when a title prefix is provided', () => {
    expect(getPageTitle('Home', '[Demo]', 'Acme')).toBe('[Demo] Home | Acme');
    expect(getPageTitle(undefined, '[Demo]', 'Acme')).toBe('[Demo] Acme');
  });
});
