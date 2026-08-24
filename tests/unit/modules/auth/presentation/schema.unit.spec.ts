import { describe, expect, it } from 'vitest';

import { PROFILE_NAME_MAX_LENGTH } from '@/modules/profile';
import { zFormFieldsOnboarding } from '@/modules/auth/presentation/schema';

describe('auth presentation schema', () => {
  it('enforces the profile name length bound during onboarding', () => {
    expect(
      zFormFieldsOnboarding().safeParse({
        name: 'a'.repeat(PROFILE_NAME_MAX_LENGTH + 1),
      }).success
    ).toBe(false);
  });
});
