import { Result } from '@bloodyowl/boxed';

import type {
  PermissionChecker,
  PermissionRequest,
} from '@/modules/kernel/application/ports/permission-checker';
import type { UserId } from '@/modules/kernel/domain/ids';
import { hasRolePermission, type Permission } from '@/modules/auth';

import type { UserForbiddenOutcome, UserResult } from './types';
import type { UserSecurityRepository } from '../ports/user-security-repository';

export async function rejectUnauthorizedUser(
  permissionChecker: PermissionChecker,
  userId: UserId,
  permission: PermissionRequest
): Promise<UserResult<UserForbiddenOutcome> | undefined> {
  const allowed = await permissionChecker.hasPermission(userId, permission);
  if (allowed.isError()) return Result.Error(allowed.getError());

  return allowed.get().type === 'permission_granted'
    ? undefined
    : Result.Ok({ type: 'user_forbidden' });
}

export async function rejectUnauthorizedUserInTransaction(
  securityRepository: UserSecurityRepository,
  userId: UserId,
  permission: PermissionRequest
): Promise<UserResult<UserForbiddenOutcome> | undefined> {
  const principal = await securityRepository.lockAuthorizationPrincipal(userId);
  if (principal.isError()) return Result.Error(principal.getError());
  const outcome = principal.get();

  return outcome.type === 'user_security_principal_found' &&
    hasRolePermission(outcome.role, permission as Permission)
    ? undefined
    : Result.Ok({ type: 'user_forbidden' });
}
