import { z } from 'zod';

import { zu } from '@/platform/lib/zod/zod-utils';

import { PROFILE_NAME_MAX_LENGTH } from '../domain/profile-policy';

export type FormFieldsProfileUpdateName = z.infer<
  ReturnType<typeof zFormFieldsProfileUpdateName>
>;
export const zFormFieldsProfileUpdateName = () =>
  z.object({
    name: zu.fieldText.required({ max: PROFILE_NAME_MAX_LENGTH }),
  });
