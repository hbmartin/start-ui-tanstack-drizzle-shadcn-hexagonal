import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { IdValidationError, type ParseResult } from '@/modules/kernel';

import { PROFILE_NAME_MAX_LENGTH } from './profile-policy';

export const zProfileIdSchema = z.string().trim().min(1).brand<'ProfileId'>();
export const zProfileNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(PROFILE_NAME_MAX_LENGTH)
  .brand<'ProfileName'>();

export type ProfileId = z.infer<typeof zProfileIdSchema>;
export type ProfileName = z.infer<typeof zProfileNameSchema>;

export const zProfileId = () => zProfileIdSchema;
export const zProfileName = () => zProfileNameSchema;

export const toProfileId = (value: string): ParseResult<ProfileId> => {
  const result = zProfileIdSchema.safeParse(value);
  if (!result.success) {
    return Result.Error(new IdValidationError('ProfileId', value));
  }
  return Result.Ok(result.data);
};

export const toProfileName = (name: string): ParseResult<ProfileName> => {
  const result = zProfileNameSchema.safeParse(name);
  if (!result.success) {
    return Result.Error(
      new IdValidationError(
        'ProfileName',
        '<redacted>',
        'ProfileName is invalid'
      )
    );
  }
  return Result.Ok(result.data);
};

export type ProfileInfoUpdate = {
  name: ProfileName;
};

export type ProfileOnboardingUpdate = {
  name: ProfileName;
  onboardedAt: Date;
};

export type ProfileUpdateResult = {
  id: ProfileId;
};

export function normalizeProfileName(name: ProfileName) {
  return name;
}
