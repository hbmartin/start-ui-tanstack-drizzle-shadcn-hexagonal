import { Result } from '@bloodyowl/boxed';
import { z } from 'zod';

import { IdValidationError } from '@/modules/kernel/domain/errors/id-validation-error';
import type {
  EmailAddress,
  ParseResult,
  UserId,
} from '@/modules/kernel/domain/ids';

const createInviteIdSchema = () => z.string().trim().min(1).brand<'InviteId'>();

const zInviteIdSchema = createInviteIdSchema();

export type InviteId = z.infer<typeof zInviteIdSchema>;

export type Invite = {
  id: InviteId;
  email: EmailAddress;
  invitedBy: UserId;
  expiresAt: Date;
  acceptedAt: Date | null;
};

export const zInviteId = createInviteIdSchema;

export const toInviteId = (value: string): ParseResult<InviteId> => {
  const result = zInviteIdSchema.safeParse(value);
  if (!result.success) {
    return Result.Error(new IdValidationError('InviteId', value));
  }
  return Result.Ok(result.data);
};

export const isInviteUsable = (invite: Invite, now: Date): boolean =>
  invite.acceptedAt === null && invite.expiresAt.getTime() > now.getTime();
