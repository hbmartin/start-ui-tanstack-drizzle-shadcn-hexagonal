import { Result } from '@bloodyowl/boxed';

import { toAuditSubjectId } from '@/modules/audit';
import type { CorrelationId, UserId } from '@/modules/kernel/domain/ids';

import type {
  UserForbiddenOutcome,
  UserResult,
  UserRevokeSessionsOutcome,
  UserUseCaseDeps,
} from './types';
import {
  rejectUnauthorizedUser,
  rejectUnauthorizedUserInTransaction,
} from './authorize-user';
import { recordRequiredAudit } from './record-required-audit';
import { isSelfTarget } from '../../domain/user-policy';
import type { UserSessionsRevokedRepositoryOutcome } from '../ports/user-security-repository';

export type RevokeUserSessionsInput = {
  correlationId: CorrelationId;
  currentUserId: UserId;
  id: UserId;
};

export async function revokeUserSessions(
  deps: UserUseCaseDeps,
  input: RevokeUserSessionsInput
): Promise<UserResult<UserRevokeSessionsOutcome>> {
  const rejection = await rejectUnauthorizedUser(
    deps.permissionChecker,
    input.currentUserId,
    { session: ['revoke'] }
  );
  if (rejection) return rejection;
  if (isSelfTarget(input.currentUserId, input.id)) {
    return Result.Ok({ type: 'user_self' });
  }

  const subjectId = toAuditSubjectId('user', input.id);
  if (subjectId.isError()) return Result.Error(subjectId.getError());
  const result = await deps.transactionRunner.run(
    async ({
      audit,
      securityRepository,
    }): Promise<
      UserResult<UserSessionsRevokedRepositoryOutcome | UserForbiddenOutcome>
    > => {
      const transactionRejection = await rejectUnauthorizedUserInTransaction(
        securityRepository,
        input.currentUserId,
        { session: ['revoke'] }
      );
      if (transactionRejection) return transactionRejection;

      const revoked = await securityRepository.revokeSessions(input.id);
      if (revoked.isError()) return Result.Error(revoked.getError());
      const outcome = revoked.get();
      if (outcome.count === 0) return Result.Ok(outcome);

      const recorded = await recordRequiredAudit(audit, {
        type: 'session.revoked',
        actor: { kind: 'user', userId: input.currentUserId },
        subject: { kind: 'user', id: subjectId.get() },
        correlationId: input.correlationId,
        metadata: { reason: 'administrator', scope: 'all' },
      });
      if (recorded.isError()) return Result.Error(recorded.getError());

      return Result.Ok(outcome);
    }
  );
  if (result.isError()) return Result.Error(result.getError());
  const outcome = result.get();
  if (outcome.type === 'user_forbidden') return Result.Ok(outcome);
  if (outcome.count === 0) {
    return Result.Ok({ type: 'user_sessions_unchanged' });
  }
  deps.logger.warn({
    correlationId: input.correlationId,
    details: {
      mode: 'all',
      revokedByUserId: input.currentUserId,
      targetUserId: input.id,
      count: outcome.count,
    },
    event: 'security.session_revoked',
  });
  return Result.Ok({ type: 'user_sessions_revoked' });
}
