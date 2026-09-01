import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { IdValidationError } from '@/modules/kernel/domain/errors/id-validation-error';
import type { ParseResult, UserId } from '@/modules/kernel/domain/ids';

export const authProviders = ['better-auth', 'workos'] as const;
export type AuthProvider = (typeof authProviders)[number];

const createAuthIdentityIdSchema = () =>
  z.string().trim().min(1).brand<'AuthIdentityId'>();

const zAuthIdentityIdSchema = createAuthIdentityIdSchema();

export type AuthIdentityId = z.infer<typeof zAuthIdentityIdSchema>;

export type AuthIdentity = {
  id: AuthIdentityId;
  userId: UserId;
  provider: AuthProvider;
  providerSubject: string;
};

export const zAuthIdentityId = createAuthIdentityIdSchema;

export const toAuthIdentityId = (
  value: string
): ParseResult<AuthIdentityId> => {
  const result = zAuthIdentityIdSchema.safeParse(value);
  if (!result.success) {
    return Result.Error(new IdValidationError('AuthIdentityId', value));
  }
  return Result.Ok(result.data);
};
