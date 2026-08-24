import { serverMutationOptions } from '@/platform/lib/tanstack-query/scoped-query-options';
import type { ServerFunctionFacade } from '@/platform/lib/tanstack-start/server-function-types';

import type { ProfileServerFunctions } from '../server';

export type ProfileQueryFacade = ServerFunctionFacade<
  Pick<ProfileServerFunctions, 'profileSubmitOnboarding' | 'profileUpdateInfo'>
>;

const profileQueryVersion = 'v1';

export const createProfileQueries = <TFacade extends ProfileQueryFacade>(
  facade: TFacade
) => ({
  submitOnboarding: () =>
    serverMutationOptions({
      mutationKey: ['profile', profileQueryVersion, 'submitOnboarding'],
      mutationFn: facade.profileSubmitOnboarding,
    }),
  updateInfo: () =>
    serverMutationOptions({
      mutationKey: ['profile', profileQueryVersion, 'updateInfo'],
      mutationFn: facade.profileUpdateInfo,
    }),
});
