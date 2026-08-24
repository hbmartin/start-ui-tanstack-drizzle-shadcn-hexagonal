import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { UserId } from '@/modules/kernel/domain/ids';

export type UserAuthRemoveOutcome = { type: 'user_auth_removed' };

export interface UserAuthGateway {
  removeUser(userId: UserId): Promise<ApplicationResult<UserAuthRemoveOutcome>>;
}
