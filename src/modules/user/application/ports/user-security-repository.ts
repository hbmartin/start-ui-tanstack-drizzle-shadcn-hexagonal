import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { SessionId, UserId } from '@/modules/kernel/domain/ids';

import type { UserRole } from '../../domain/user';

export type UserSecurityPrincipalRepositoryOutcome =
  | Readonly<{ role: UserRole; type: 'user_security_principal_found' }>
  | Readonly<{ type: 'user_security_principal_not_found' }>;

export type UserSessionsRevokedRepositoryOutcome = Readonly<{
  count: number;
  type: 'user_sessions_revoked';
}>;

export type UserSessionRevokedRepositoryOutcome =
  | Readonly<{ type: 'user_session_not_found' }>
  | Readonly<{ type: 'user_session_revoked' }>;

/** Transaction-bound security mutations over auth-owned durable state. */
export interface UserSecurityRepository {
  lockAuthorizationPrincipal(
    userId: UserId
  ): Promise<ApplicationResult<UserSecurityPrincipalRepositoryOutcome>>;
  revokeSessions(
    userId: UserId
  ): Promise<ApplicationResult<UserSessionsRevokedRepositoryOutcome>>;
  revokeSession(input: {
    sessionId: SessionId;
    userId: UserId;
  }): Promise<ApplicationResult<UserSessionRevokedRepositoryOutcome>>;
}
