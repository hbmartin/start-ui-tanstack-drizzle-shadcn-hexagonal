import { afterEach, describe, expect, it } from 'vitest';

import {
  getBrandAppName,
  getPageTitle,
  setBrandAppName,
} from '@/platform/lib/get-page-title';

describe('getPageTitle', () => {
  afterEach(() => {
    setBrandAppName('Start UI');
  });

  it('omits the prefix separator when no title prefix is provided', () => {
    expect(getPageTitle('Home')).toBe('Home | Start UI');
    expect(getPageTitle()).toBe('Start UI');
  });

  it('adds a separator when a title prefix is provided', () => {
    expect(getPageTitle('Home', '[Demo]')).toBe('[Demo] Home | Start UI');
    expect(getPageTitle(undefined, '[Demo]')).toBe('[Demo] Start UI');
  });

  it('uses the adopter app name once configured', () => {
    setBrandAppName('Acme Books');

    expect(getBrandAppName()).toBe('Acme Books');
    expect(getPageTitle('Home')).toBe('Home | Acme Books');
    expect(getPageTitle()).toBe('Acme Books');
  });

  it('falls back to the template name for blank app names', () => {
    setBrandAppName('   ');

    expect(getPageTitle()).toBe('Start UI');
  });
});
