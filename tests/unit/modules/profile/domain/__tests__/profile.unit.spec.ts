import { testProfileId, testProfileName } from '@tests/support/branded-values';
import { describe, expect, it } from 'vitest';

import {
  normalizeProfileName,
  toProfileId,
  toProfileName,
  zProfileId,
  zProfileName,
} from '@/modules/profile/domain/profile';
import { PROFILE_NAME_MAX_LENGTH } from '@/modules/profile/domain/profile-policy';

describe('profile domain', () => {
  it('creates fresh profile schemas for each consumer', () => {
    expect(zProfileId()).not.toBe(zProfileId());
    expect(zProfileName()).not.toBe(zProfileName());
  });

  it('keeps the Profile identifier distinct and non-empty', () => {
    expect(testProfileId(' profile-1 ')).toBe('profile-1');
    expect(toProfileId(' ').isError()).toBe(true);
  });

  it('normalizes parsed profile names', () => {
    expect(normalizeProfileName(testProfileName(' Harold '))).toBe('Harold');
  });

  it('parses valid profile names and rejects invalid names', () => {
    expect(toProfileName(' Harold ').isOk()).toBe(true);
    expect(toProfileName(' ').isError()).toBe(true);
    expect(
      toProfileName('a'.repeat(PROFILE_NAME_MAX_LENGTH + 1)).isError()
    ).toBe(true);
  });

  it('redacts invalid profile name values from error details', () => {
    const result = toProfileName('Sensitive Profile Name'.repeat(20));
    const error = result.match({
      Ok: () => {
        throw new Error('Expected parser to fail.');
      },
      Error: (value) => value,
    });

    expect(error.details).toMatchObject({
      typeName: 'ProfileName',
      value: '<redacted>',
    });
  });
});
