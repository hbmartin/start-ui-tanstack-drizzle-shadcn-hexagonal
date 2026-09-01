import { z } from 'zod';

import type { ProfileUseCases } from '@/modules/profile';
import type { ProtectedContext } from '@/modules/auth/backend';
import { unwrapApplicationResult } from '@/modules/kernel/transport/tanstack/result-mapper';

import { zProfileName } from '../../domain/profile';

export const zSubmitOnboardingInput = () => z.object({ name: zProfileName() });
export const zUpdateInfoInput = () => z.object({ name: zProfileName() });

type ProfileHandlerDeps = {
  getUseCases: (ctx: ProtectedContext) => ProfileUseCases;
};

const profileReasonConfig = {
  profile_forbidden: {
    code: 'FORBIDDEN',
    reason: 'permission_denied',
    target: 'profile',
  },
  profile_not_found: {
    code: 'NOT_FOUND',
    reason: 'not_found',
    target: 'profile',
  },
  profile_updated: () => undefined,
} as const;

export const createProfileHandlers = ({ getUseCases }: ProfileHandlerDeps) => {
  const submitOnboarding = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zSubmitOnboardingInput>>
  ) => {
    await unwrapApplicationResult(
      getUseCases(ctx).submitOnboarding({
        currentUserId: ctx.scope.userId,
        name: data.name,
      }),
      profileReasonConfig
    );
  };

  const updateInfo = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zUpdateInfoInput>>
  ) => {
    await unwrapApplicationResult(
      getUseCases(ctx).updateInfo({
        currentUserId: ctx.scope.userId,
        name: data.name,
      }),
      profileReasonConfig
    );
  };

  return {
    submitOnboarding,
    updateInfo,
  };
};

export type ProfileHandlers = ReturnType<typeof createProfileHandlers>;
