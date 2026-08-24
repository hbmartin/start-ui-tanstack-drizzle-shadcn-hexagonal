import {
  type ProfileRepository,
  createProfileUseCases,
} from '@/modules/profile';
import { createProfileRepository } from '@/modules/auth/infrastructure/drizzle/profile-repository-drizzle';

import { getKernel, type Kernel } from './kernel';
import { createCachedFactory } from './shared/singleton';

export type ProfileOverrides = {
  kernel?: Kernel;
  profileRepository?: ProfileRepository;
};

const buildProfileUseCases = (overrides?: ProfileOverrides) => {
  const kernel = overrides?.kernel ?? getKernel();
  return createProfileUseCases({
    profileRepository:
      overrides?.profileRepository ??
      createProfileRepository({ db: kernel.db }),
    clock: kernel.clock,
    logger: kernel.logger,
    permissionChecker: kernel.permissionChecker,
  });
};

const factory = createCachedFactory(buildProfileUseCases);

export const getProfileUseCases = (overrides?: ProfileOverrides) =>
  factory.get(overrides);

/** Test-only. */
export const __resetProfileComposition = () => factory.reset();
