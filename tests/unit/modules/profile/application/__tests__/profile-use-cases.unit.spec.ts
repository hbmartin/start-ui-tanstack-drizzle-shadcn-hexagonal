import { Result } from '@bloodyowl/boxed';
import { testProfileId, testProfileName } from '@tests/support/branded-values';
import { describe, expect, it, vi } from 'vitest';

import type { ProfileRepository } from '@/modules/profile/application/ports/profile-repository';
import { createProfileUseCases } from '@/modules/profile/factory';
import type { PermissionChecker } from '@/modules/kernel/application/ports/permission-checker';
import { toUserId } from '@/modules/kernel/domain/ids';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';

const logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

const clock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
};

const repository: ProfileRepository = {
  submitOnboarding: async (id) =>
    Result.Ok({
      type: 'profile_updated',
      profile: { id: testProfileId(id) },
    }),
  updateInfo: async (id) =>
    Result.Ok({
      type: 'profile_updated',
      profile: { id: testProfileId(id) },
    }),
};

const allowed: PermissionChecker = {
  hasPermission: async () => Result.Ok({ type: 'permission_granted' }),
};

const forbidden: PermissionChecker = {
  hasPermission: async () => Result.Ok({ type: 'permission_denied' }),
};

const scope = (userId: string) =>
  ({ userId: unwrapParseResult(toUserId(userId)), role: 'user' }) as const;

function getOk<TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) {
  if (result.isError()) throw result.getError();
  return result.get();
}

describe('profile use cases', () => {
  it('submits onboarding and updates info', async () => {
    const useCases = createProfileUseCases({
      profileRepository: repository,
      clock,
      logger,
      permissionChecker: allowed,
    });

    const submitted = await useCases.submitOnboarding({
      currentUserId: scope('user-1').userId,
      name: testProfileName(' User '),
    });
    const updated = await useCases.updateInfo({
      currentUserId: scope('user-1').userId,
      name: testProfileName('User'),
    });

    expect(getOk(submitted)).toEqual({
      type: 'profile_updated',
      profile: { id: 'user-1' },
    });
    expect(getOk(updated)).toEqual({
      type: 'profile_updated',
      profile: { id: 'user-1' },
    });
  });

  it('returns not_found when profile rows are missing', async () => {
    const useCases = createProfileUseCases({
      profileRepository: {
        submitOnboarding: async () => Result.Ok({ type: 'profile_not_found' }),
        updateInfo: async () => Result.Ok({ type: 'profile_not_found' }),
      },
      clock,
      logger,
      permissionChecker: allowed,
    });

    const submitted = await useCases.submitOnboarding({
      currentUserId: scope('missing').userId,
      name: testProfileName('User'),
    });
    const updated = await useCases.updateInfo({
      currentUserId: scope('missing').userId,
      name: testProfileName('User'),
    });

    expect(getOk(submitted)).toEqual({ type: 'profile_not_found' });
    expect(getOk(updated)).toEqual({ type: 'profile_not_found' });
  });

  it('rejects profile writes without profile update permission', async () => {
    const repositoryWithSpies: ProfileRepository = {
      submitOnboarding: async (id) =>
        Result.Ok({
          type: 'profile_updated',
          profile: { id: testProfileId(id) },
        }),
      updateInfo: async (id) =>
        Result.Ok({
          type: 'profile_updated',
          profile: { id: testProfileId(id) },
        }),
    };
    const submitSpy = vi.spyOn(repositoryWithSpies, 'submitOnboarding');
    const updateSpy = vi.spyOn(repositoryWithSpies, 'updateInfo');
    const useCases = createProfileUseCases({
      profileRepository: repositoryWithSpies,
      clock,
      logger,
      permissionChecker: forbidden,
    });

    const submitted = await useCases.submitOnboarding({
      currentUserId: scope('user-1').userId,
      name: testProfileName('User'),
    });
    const updated = await useCases.updateInfo({
      currentUserId: scope('user-1').userId,
      name: testProfileName('User'),
    });

    expect(getOk(submitted)).toEqual({ type: 'profile_forbidden' });
    expect(getOk(updated)).toEqual({ type: 'profile_forbidden' });
    expect(submitSpy).not.toHaveBeenCalled();
    expect(updateSpy).not.toHaveBeenCalled();
  });
});
