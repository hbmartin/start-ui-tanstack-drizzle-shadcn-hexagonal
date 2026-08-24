import { Result } from '@bloodyowl/boxed';

import { toAuditSubjectId } from '@/modules/audit';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type {
  CorrelationId,
  SessionId,
  UserId,
} from '@/modules/kernel/domain/ids';

import type {
  UserForbiddenOutcome,
  UserResult,
  UserRevokeSessionOutcome,
  UserUseCaseDeps,
} from './types';
import {
  rejectUnauthorizedUser,
  rejectUnauthorizedUserInTransaction,
} from './authorize-user';
import type { UserSessionRevokedRepositoryOutcome } from '../ports/user-security-repository';

export type RevokeUserSessionInput = {
  correlationId: CorrelationId;
  currentUserId: UserId;
  currentSessionId: SessionId;
  id: UserId;
  sessionId: SessionId;
};

export async function revokeUserSession(
  deps: UserUseCaseDeps,
  input: RevokeUserSessionInput
): Promise<UserResult<UserRevokeSessionOutcome>> {
  const rejection = await rejectUnauthorizedUser(
    deps.permissionChecker,
    input.currentUserId,
    { session: ['revoke'] }
  );
  if (rejection) return rejection;
  if (input.currentSessionId === input.sessionId) {
    return Result.Ok({ type: 'user_self' });
  }

  const subjectId = toAuditSubjectId('session', input.sessionId);
  if (subjectId.isError()) return Result.Error(subjectId.getError());
  const result = await deps.transactionRunner.run(
    async ({
      audit,
      securityRepository,
    }): Promise<
      UserResult<UserSessionRevokedRepositoryOutcome | UserForbiddenOutcome>
    > => {
      const transactionRejection = await rejectUnauthorizedUserInTransaction(
        securityRepository,
        input.currentUserId,
        { session: ['revoke'] }
      );
      if (transactionRejection) return transactionRejection;

      const revoked = await securityRepository.revokeSession({
        userId: input.id,
        sessionId: input.sessionId,
      });
      if (revoked.isError()) return Result.Error(revoked.getError());
      const outcome = revoked.get();
      if (outcome.type === 'user_session_not_found') return Result.Ok(outcome);

      const recorded = await audit.record({
        type: 'session.revoked',
        actor: { kind: 'user', userId: input.currentUserId },
        subject: { kind: 'session', id: subjectId.get() },
        correlationId: input.correlationId,
        metadata: { reason: 'administrator', scope: 'single' },
      });
      if (recorded.isError()) return Result.Error(recorded.getError());
      if (recorded.get().type !== 'audit_recorded') {
        return Result.Error(
          new AppError({
            code: 'REQUIRED_AUDIT_EVENT_NOT_RECORDED',
            category: 'system',
            status: 500,
            message: 'Required session revocation audit event was not recorded',
          })
        );
      }

      return Result.Ok(outcome);
    }
  );
  if (result.isError()) return Result.Error(result.getError());
  const outcome = result.get();
  if (outcome.type === 'user_forbidden') return Result.Ok(outcome);
  if (outcome.type === 'user_session_not_found') return Result.Ok(outcome);
  deps.logger.warn({
    correlationId: input.correlationId,
    details: {
      mode: 'single',
      revokedByUserId: input.currentUserId,
      sessionId: input.sessionId,
      targetUserId: input.id,
    },
    event: 'security.session_revoked',
  });
  return Result.Ok({ type: 'user_session_revoked' });
}
