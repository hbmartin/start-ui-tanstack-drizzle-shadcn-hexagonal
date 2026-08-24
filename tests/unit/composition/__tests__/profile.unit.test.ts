import { Result } from '@bloodyowl/boxed';
import { testProfileId, testProfileName } from '@tests/support/branded-values';
import { makeTestKernel } from '@tests/unit/composition/helpers';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetProfileComposition,
  getProfileUseCases,
} from '@/composition/profile';
import type { ProfileRepository } from '@/modules/profile';
import { toUserId } from '@/modules/kernel/domain/ids';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';

const makeProfileRepository = (
  overrides: Partial<ProfileRepository> = {}
): ProfileRepository => ({
  submitOnboarding: async (userId) =>
    Result.Ok({
      type: 'profile_updated',
      profile: { id: testProfileId(userId) },
    }),
  updateInfo: async (userId) =>
    Result.Ok({
      type: 'profile_updated',
      profile: { id: testProfileId(userId) },
    }),
  ...overrides,
});

const scope = (userId: string) =>
  ({ userId: unwrapParseResult(toUserId(userId)), role: 'user' }) as const;

function getOk<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isError()) throw result.getError();
  return result.get();
}

describe('profile composition', () => {
  beforeEach(() => {
    __resetProfileComposition();
  });

  it('returns a singleton with use case methods when no overrides are provided', () => {
    const first = getProfileUseCases();
    const second = getProfileUseCases();

    expect(first).toBe(second);
    expect(typeof first.updateInfo).toBe('function');
  });

  it('returns a fresh object when overrides are provided', () => {
    const singleton = getProfileUseCases();
    const overridden = getProfileUseCases({
      kernel: makeTestKernel(),
      profileRepository: makeProfileRepository(),
    });

    expect(overridden).not.toBe(singleton);
  });

  it('routes use case calls through the overridden repository', async () => {
    const updateInfo = vi.fn(async (userId) =>
      Result.Ok({
        type: 'profile_updated' as const,
        profile: { id: testProfileId(userId) },
      })
    );
    const useCases = getProfileUseCases({
      kernel: makeTestKernel(),
      profileRepository: makeProfileRepository({ updateInfo }),
    });

    const result = await useCases.updateInfo({
      currentUserId: scope('user-1').userId,
      name: testProfileName('Updated User'),
    });

    expect(getOk(result)).toEqual({
      type: 'profile_updated',
      profile: { id: 'user-1' },
    });
    expect(updateInfo).toHaveBeenCalledWith('user-1', {
      name: testProfileName('Updated User'),
    });
  });
});
