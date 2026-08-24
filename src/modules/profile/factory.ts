import { submitOnboarding } from './application/use-cases/submit-onboarding';
import type { ProfileUseCaseDeps } from './application/use-cases/types';
import { updateProfileInfo } from './application/use-cases/update-profile-info';

export function createProfileUseCases(deps: ProfileUseCaseDeps) {
  return {
    submitOnboarding: (input: Parameters<typeof submitOnboarding>[1]) =>
      submitOnboarding(deps, input),
    updateInfo: (input: Parameters<typeof updateProfileInfo>[1]) =>
      updateProfileInfo(deps, input),
  };
}

export type ProfileUseCases = ReturnType<typeof createProfileUseCases>;
