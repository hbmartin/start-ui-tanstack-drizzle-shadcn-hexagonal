import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { UserId } from '@/modules/kernel/domain/ids';

import type {
  ProfileOnboardingUpdate,
  ProfileInfoUpdate,
  ProfileUpdateResult,
} from '../../domain/profile';

export type ProfileUpdateRepositoryOutcome =
  | { type: 'profile_updated'; profile: ProfileUpdateResult }
  | { type: 'profile_not_found' };

export interface ProfileRepository {
  submitOnboarding(
    userId: UserId,
    input: ProfileOnboardingUpdate
  ): Promise<ApplicationResult<ProfileUpdateRepositoryOutcome>>;
  updateInfo(
    userId: UserId,
    input: ProfileInfoUpdate
  ): Promise<ApplicationResult<ProfileUpdateRepositoryOutcome>>;
}
