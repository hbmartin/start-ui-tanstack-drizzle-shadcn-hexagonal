import { Result } from '@bloodyowl/boxed';

import { toAuditSubjectId, type AuditSubjectId } from '@/modules/audit';
import { hasRolePermission } from '@/modules/auth';
import type { CorrelationId, UserId } from '@/modules/kernel/domain/ids';

import { rejectUnauthorizedUser } from './authorize-user';
import { recordRequiredAudit } from './record-required-audit';
import type {
  UserDeleteOutcome,
  UserResult,
  UserTransactionContext,
  UserUseCaseDeps,
} from './types';
import { isSelfTarget } from '../../domain/user-policy';

export type DeleteUserInput = {
  correlationId: CorrelationId;
  currentUserId: UserId;
  id: UserId;
};

const deleteLockedUser = async (
  context: UserTransactionContext,
  input: DeleteUserInput,
  subjectId: AuditSubjectId<'user'>
): Promise<UserResult<UserDeleteOutcome>> => {
  const locked = await context.securityRepository.lockMutationPrincipals({
    actorId: input.currentUserId,
    targetId: input.id,
  });
  if (locked.isError()) return Result.Error(locked.getError());
  const { actor, target } = locked.get();
  if (
    actor.type !== 'user_security_principal_found' ||
    !hasRolePermission(actor.role, { user: ['delete'] })
  ) {
    return Result.Ok({ type: 'user_forbidden' });
  }
  if (target.type === 'user_security_principal_not_found') {
    return Result.Ok({ type: 'user_not_found' });
  }

  const deleted = await context.securityRepository.deleteUser(input.id);
  if (deleted.isError()) return Result.Error(deleted.getError());
  const outcome = deleted.get();
  if (outcome.type === 'user_not_found') return Result.Ok(outcome);

  const audited = await recordRequiredAudit(context.audit, {
    type: 'administration.user-deleted',
    actor: { kind: 'user', userId: input.currentUserId },
    subject: { kind: 'user', id: subjectId },
    correlationId: input.correlationId,
    metadata: { reason: 'administrator' },
  });
  if (audited.isError()) return Result.Error(audited.getError());

  return Result.Ok(outcome);
};

export async function deleteUser(
  deps: UserUseCaseDeps,
  input: DeleteUserInput
): Promise<UserResult<UserDeleteOutcome>> {
  const rejection = await rejectUnauthorizedUser(
    deps.permissionChecker,
    input.currentUserId,
    { user: ['delete'] }
  );
  if (rejection) return rejection;
  if (isSelfTarget(input.currentUserId, input.id)) {
    return Result.Ok({ type: 'user_self' });
  }
  const subjectId = toAuditSubjectId('user', input.id);
  if (subjectId.isError()) return Result.Error(subjectId.getError());

  const result = await deps.transactionRunner.run((context) =>
    deleteLockedUser(context, input, subjectId.get())
  );
  if (result.isError()) return Result.Error(result.getError());
  const outcome = result.get();
  if (outcome.type === 'user_deleted') {
    deps.logger.info({
      event: 'user.delete',
      correlationId: input.correlationId,
      details: {
        deletedByUserId: input.currentUserId,
        userId: input.id,
      },
    });
  }
  return Result.Ok(outcome);
}
