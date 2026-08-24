import { createServerFn, createServerOnlyFn } from '@tanstack/react-start';

import {
  createServerFunctionInvoker,
  type ServerFnContextRunner,
} from '@/platform/lib/tanstack-start/server-function-handler';

import type { ProtectedContext } from '@/modules/auth/backend';

import {
  type ProfileHandlers,
  createProfileHandlers,
  zSubmitOnboardingInput,
  zUpdateInfoInput,
} from '../http/profile-handlers';

type ProtectedRunner = ServerFnContextRunner<ProtectedContext>;

type ProfileServerRuntimeDeps = {
  handlers: ProfileHandlers;
  withProtectedMutation: ProtectedRunner;
};

const getDeps = createServerOnlyFn(
  async (): Promise<ProfileServerRuntimeDeps> => {
    const [{ getProfileUseCases }, { getKernel }, { withProtectedMutation }] =
      await Promise.all([
        import('@/composition/profile'),
        import('@/composition/kernel'),
        import('@/modules/auth/backend'),
      ]);

    return {
      handlers: createProfileHandlers({
        getUseCases: (ctx) =>
          getProfileUseCases({
            kernel: getKernel({ logger: ctx.logger }),
          }),
      }),
      withProtectedMutation,
    };
  }
);

const runMutation = createServerFunctionInvoker({
  getDeps,
  selectRunner: (deps) => deps.withProtectedMutation,
});

export const profileSubmitOnboarding = createServerFn({ method: 'POST' })
  .validator(zSubmitOnboardingInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('profile.submitOnboarding')(
      data,
      ({ handlers }, ctx, input) => handlers.submitOnboarding(ctx, input)
    )
  );

export const profileUpdateInfo = createServerFn({ method: 'POST' })
  .validator(zUpdateInfoInput())
  .handler(async ({ data }) =>
    runMutation.withOperation('profile.updateInfo')(
      data,
      ({ handlers }, ctx, input) => handlers.updateInfo(ctx, input)
    )
  );

export type ProfileServerFunctions = {
  profileSubmitOnboarding: typeof profileSubmitOnboarding;
  profileUpdateInfo: typeof profileUpdateInfo;
};
