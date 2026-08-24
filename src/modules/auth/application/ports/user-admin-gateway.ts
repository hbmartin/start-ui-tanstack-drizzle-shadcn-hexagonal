import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { UserId } from '@/modules/kernel/domain/ids';

export type UserAdminRemoveOutcome = { type: 'auth_user_removed' };

export interface UserAdminGateway {
  removeUser(input: {
    userId: UserId;
    headers: Headers;
  }): Promise<ApplicationResult<UserAdminRemoveOutcome>>;
}
