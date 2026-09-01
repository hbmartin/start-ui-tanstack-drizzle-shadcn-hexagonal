import type { Clock } from '@/modules/kernel/application/ports/clock';
import type { Logger } from '@/modules/kernel/application/ports/logger';
import type { PermissionChecker } from '@/modules/kernel/application/ports/permission-checker';
import type { ApplicationResult } from '@/modules/kernel/application/result';

import type {
  ProfileRepository,
  ProfileUpdateRepositoryOutcome,
} from '../ports/profile-repository';

export type ProfileUseCaseDeps = {
  profileRepository: ProfileRepository;
  clock: Clock;
  logger: Logger;
  permissionChecker: PermissionChecker;
};

export type ProfileUpdateOutcome =
  | ProfileUpdateRepositoryOutcome
  | { type: 'profile_forbidden' };

export type ProfileResult<TOutcome> = ApplicationResult<TOutcome>;
