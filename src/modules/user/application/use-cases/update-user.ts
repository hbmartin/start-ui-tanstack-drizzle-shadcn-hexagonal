import { Result } from '@bloodyowl/boxed';
import { match, P } from 'ts-pattern';

import type { CorrelationId, UserId } from '@/modules/kernel';

import type { UserResult, UserUpdateOutcome, UserUseCaseDeps } from './types';
import { rejectUnauthorizedUser } from './authorize-user';
import { buildUserUpdatePersistenceInput } from './update-user-persistence-input';
import { updateUserRole } from './update-user-role';
import type { UserUpdateInput } from '../../domain/user';
import { canChangeRole } from '../../domain/user-policy';

export type UpdateUserInput = {
  correlationId: CorrelationId;
  currentUserId: UserId;
  id: UserId;
  user: UserUpdateInput;
};

export async function updateUser(
  deps: UserUseCaseDeps,
  input: UpdateUserInput
): Promise<UserResult<UserUpdateOutcome>> {
  const rejection = await rejectUnauthorizedUser(
    deps.permissionChecker,
    input.currentUserId,
    { user: ['update'] }
  );
  if (rejection) return rejection;

  const currentResult = await deps.userRepository.getUpdateSnapshot(input.id);
  const currentResultBranch = match(currentResult)
    .with(Result.P.Error(P.select()), (error) => ({
      result: Result.Error(error),
      type: 'return' as const,
    }))
    .with(Result.P.Ok({ type: 'user_not_found' }), () => ({
      result: Result.Ok({ type: 'user_not_found' as const }),
      type: 'return' as const,
    }))
    .with(
      Result.P.Ok({
        snapshot: P.select(),
        type: 'user_update_snapshot_found',
      }),
      (snapshot) => ({ snapshot, type: 'continue' as const })
    )
    .exhaustive();
  if (currentResultBranch.type === 'return') return currentResultBranch.result;
  const current = currentResultBranch.snapshot;

  const submittedRole = input.user.role ?? undefined;
  const nextRole = canChangeRole({
    currentUserId: input.currentUserId,
    userId: input.id,
    nextRole: submittedRole,
    currentRole: current.role,
  })
    ? submittedRole
    : undefined;

  if (!nextRole) {
    const updated = await deps.userRepository.update(
      input.id,
      buildUserUpdatePersistenceInput(current, input.user, undefined)
    );
    if (updated.isError()) return Result.Error(updated.getError());
    deps.logger.info({ event: 'user.update', details: { userId: input.id } });
    return Result.Ok(updated.get());
  }

  const roleRejection = await rejectUnauthorizedUser(
    deps.permissionChecker,
    input.currentUserId,
    { user: ['set-role'] }
  );
  if (roleRejection) return roleRejection;

  const roleChange = await updateUserRole(deps, {
    correlationId: input.correlationId,
    currentUserId: input.currentUserId,
    id: input.id,
    submittedRole: nextRole,
    user: input.user,
  });
  if (roleChange.isError()) return Result.Error(roleChange.getError());
  const outcome = roleChange.get();
  if (outcome.type === 'user_forbidden') return Result.Ok(outcome);

  deps.logger.info({ event: 'user.update', details: { userId: input.id } });
  if (outcome.revokedCount !== undefined && outcome.revokedCount > 0) {
    deps.logger.warn({
      event: 'security.session_revoked',
      correlationId: input.correlationId,
      details: {
        mode: 'all',
        reason: 'role_changed',
        revokedByUserId: input.currentUserId,
        targetUserId: input.id,
        count: outcome.revokedCount,
      },
    });
  }
  return Result.Ok(outcome.outcome);
}
