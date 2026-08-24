import { Result } from '@bloodyowl/boxed';

import type { UserId } from '@/modules/kernel/domain/ids';

import type {
  ProfileResult,
  ProfileUpdateOutcome,
  ProfileUseCaseDeps,
} from './types';
import { type ProfileName, normalizeProfileName } from '../../domain/profile';

export type SubmitOnboardingInput = {
  currentUserId: UserId;
  name: ProfileName;
};

export async function submitOnboarding(
  deps: ProfileUseCaseDeps,
  input: SubmitOnboardingInput
): Promise<ProfileResult<ProfileUpdateOutcome>> {
  const allowed = await deps.permissionChecker.hasPermission(
    input.currentUserId,
    { profile: ['update'] }
  );
  if (allowed.isError()) return Result.Error(allowed.getError());
  if (allowed.get().type === 'permission_denied') {
    return Result.Ok({ type: 'profile_forbidden' });
  }

  deps.logger.info({
    event: 'profile.submit_onboarding',
    userId: input.currentUserId,
  });
  const result = await deps.profileRepository.submitOnboarding(
    input.currentUserId,
    {
      name: normalizeProfileName(input.name),
      onboardedAt: deps.clock.now(),
    }
  );
  if (result.isError()) return Result.Error(result.getError());
  return Result.Ok(result.get());
}
