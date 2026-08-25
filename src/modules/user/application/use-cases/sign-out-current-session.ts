import { Result } from '@bloodyowl/boxed';

import { toAuditSubjectId } from '@/modules/audit';
import type {
  CorrelationId,
  SessionId,
  UserId,
} from '@/modules/kernel/domain/ids';

import { recordRequiredAudit } from './record-required-audit';
import type { UserResult, UserSignOutOutcome, UserUseCaseDeps } from './types';

export type SignOutCurrentSessionInput = {
  correlationId: CorrelationId;
  currentSessionId: SessionId;
  currentUserId: UserId;
};

export async function signOutCurrentSession(
  deps: UserUseCaseDeps,
  input: SignOutCurrentSessionInput
): Promise<UserResult<UserSignOutOutcome>> {
  const subjectId = toAuditSubjectId('session', input.currentSessionId);
  if (subjectId.isError()) return Result.Error(subjectId.getError());

  const result = await deps.transactionRunner.run(
    async ({
      audit,
      securityRepository,
    }): Promise<UserResult<UserSignOutOutcome>> => {
      const revoked = await securityRepository.revokeSession({
        sessionId: input.currentSessionId,
        userId: input.currentUserId,
      });
      if (revoked.isError()) return Result.Error(revoked.getError());
      if (revoked.get().type === 'user_session_not_found') {
        return Result.Ok({ type: 'user_session_not_found' as const });
      }

      const recorded = await recordRequiredAudit(audit, {
        type: 'authentication.signed-out',
        actor: { kind: 'user', userId: input.currentUserId },
        subject: { kind: 'session', id: subjectId.get() },
        correlationId: input.correlationId,
        metadata: { scope: 'current-session' },
      });
      if (recorded.isError()) return Result.Error(recorded.getError());
      return Result.Ok({ type: 'user_signed_out' as const });
    }
  );
  if (result.isError()) return Result.Error(result.getError());
  if (result.get().type === 'user_signed_out') {
    deps.logger.info({
      correlationId: input.correlationId,
      details: {
        sessionId: input.currentSessionId,
        userId: input.currentUserId,
      },
      event: 'authentication.signed_out',
    });
  }
  return Result.Ok(result.get());
}
