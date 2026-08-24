import { Result } from '@bloodyowl/boxed';

import {
  toAuditSubjectId,
  type AuditPort,
  type AuditSubjectId,
} from '@/modules/audit';
import { hasRolePermission } from '@/modules/auth';
import type { CorrelationId, UserId } from '@/modules/kernel';

import type {
  UserForbiddenOutcome,
  UserResult,
  UserTransactionContext,
  UserUseCaseDeps,
} from './types';
import { recordRequiredAudit } from './record-required-audit';
import { buildUserUpdatePersistenceInput } from './update-user-persistence-input';
import type { UserUpdateRepositoryOutcome } from '../ports/user-repository';
import type {
  UserSecurityPrincipalRepositoryOutcome,
  UserSecurityUpdateTargetRepositoryOutcome,
} from '../ports/user-security-repository';
import type { UserRole, UserUpdateInput } from '../../domain/user';
import { canChangeRole } from '../../domain/user-policy';

type RoleChangeInput = Readonly<{
  correlationId: CorrelationId;
  currentUserId: UserId;
  id: UserId;
  submittedRole: UserRole;
  user: UserUpdateInput;
}>;

type LockedRoleChangePrincipals = Readonly<{
  actor: UserSecurityPrincipalRepositoryOutcome;
  target: UserSecurityUpdateTargetRepositoryOutcome;
}>;

const compareUserIds = (left: UserId, right: UserId) => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

export type RoleChangeCompleted = Readonly<{
  outcome: UserUpdateRepositoryOutcome;
  revokedCount?: number;
  type: 'user_role_change_completed';
}>;

const completed = (
  outcome: UserUpdateRepositoryOutcome,
  revokedCount?: number
): RoleChangeCompleted => ({
  type: 'user_role_change_completed',
  outcome,
  ...(revokedCount === undefined ? {} : { revokedCount }),
});

const recordRoleChangeAudits = async (input: {
  actorId: UserId;
  audit: AuditPort;
  correlationId: CorrelationId;
  from: UserRole;
  revokedCount: number;
  subjectId: AuditSubjectId<'user'>;
  to: UserRole;
}) => {
  const roleAudit = await recordRequiredAudit(input.audit, {
    type: 'authorization.role-changed',
    actor: { kind: 'user', userId: input.actorId },
    subject: { kind: 'user', id: input.subjectId },
    correlationId: input.correlationId,
    metadata: { from: input.from, to: input.to },
  });
  if (roleAudit.isError() || input.revokedCount === 0) return roleAudit;

  return recordRequiredAudit(input.audit, {
    type: 'session.revoked',
    actor: { kind: 'user', userId: input.actorId },
    subject: { kind: 'user', id: input.subjectId },
    correlationId: input.correlationId,
    metadata: { reason: 'role-change', scope: 'all' },
  });
};

const executeLockedMutation = async (
  context: UserTransactionContext,
  input: RoleChangeInput,
  subjectId: AuditSubjectId<'user'>,
  target: UserSecurityUpdateTargetRepositoryOutcome
): Promise<UserResult<RoleChangeCompleted>> => {
  if (target.type === 'user_security_update_target_not_found') {
    return Result.Ok(completed({ type: 'user_not_found' }));
  }

  const durableCurrent = target.snapshot;
  const durableNextRole = canChangeRole({
    currentUserId: input.currentUserId,
    userId: input.id,
    nextRole: input.submittedRole,
    currentRole: durableCurrent.role,
  })
    ? input.submittedRole
    : undefined;
  const updated = await context.userRepository.update(
    input.id,
    buildUserUpdatePersistenceInput(durableCurrent, input.user, durableNextRole)
  );
  if (updated.isError()) return Result.Error(updated.getError());
  const updateOutcome = updated.get();
  if (updateOutcome.type !== 'user_updated' || !durableNextRole) {
    return Result.Ok(completed(updateOutcome));
  }

  const revoked = await context.securityRepository.revokeSessions(input.id);
  if (revoked.isError()) return Result.Error(revoked.getError());
  const revokedCount = revoked.get().count;
  const audited = await recordRoleChangeAudits({
    actorId: input.currentUserId,
    audit: context.audit,
    correlationId: input.correlationId,
    from: durableCurrent.role,
    revokedCount,
    subjectId,
    to: durableNextRole,
  });
  if (audited.isError()) return Result.Error(audited.getError());

  return Result.Ok(completed(updateOutcome, revokedCount));
};

const lockRoleChangePrincipals = async (
  context: UserTransactionContext,
  input: RoleChangeInput
): Promise<UserResult<LockedRoleChangePrincipals>> => {
  let actor: UserSecurityPrincipalRepositoryOutcome = {
    type: 'user_security_principal_not_found',
  };
  let target: UserSecurityUpdateTargetRepositoryOutcome = {
    type: 'user_security_update_target_not_found',
  };
  const locks = [
    { kind: 'actor' as const, userId: input.currentUserId },
    { kind: 'target' as const, userId: input.id },
  ].toSorted((left, right) => compareUserIds(left.userId, right.userId));

  for (const lock of locks) {
    if (lock.kind === 'actor') {
      const locked =
        await context.securityRepository.lockAuthorizationPrincipal(
          lock.userId
        );
      if (locked.isError()) return Result.Error(locked.getError());
      actor = locked.get();
    } else {
      const locked = await context.securityRepository.lockUserForUpdate(
        lock.userId
      );
      if (locked.isError()) return Result.Error(locked.getError());
      target = locked.get();
    }
  }

  return Result.Ok({ actor, target });
};

const runRoleChange = async (
  context: UserTransactionContext,
  input: RoleChangeInput,
  subjectId: AuditSubjectId<'user'>
): Promise<UserResult<RoleChangeCompleted | UserForbiddenOutcome>> => {
  const locked = await lockRoleChangePrincipals(context, input);
  if (locked.isError()) return Result.Error(locked.getError());
  const { actor, target } = locked.get();
  if (
    actor.type !== 'user_security_principal_found' ||
    !hasRolePermission(actor.role, { user: ['set-role', 'update'] })
  ) {
    return Result.Ok({ type: 'user_forbidden' });
  }

  return executeLockedMutation(context, input, subjectId, target);
};

export async function updateUserRole(
  deps: UserUseCaseDeps,
  input: RoleChangeInput
): Promise<UserResult<RoleChangeCompleted | UserForbiddenOutcome>> {
  const subjectId = toAuditSubjectId('user', input.id);
  if (subjectId.isError()) return Result.Error(subjectId.getError());

  return deps.transactionRunner.run((context) =>
    runRoleChange(context, input, subjectId.get())
  );
}
