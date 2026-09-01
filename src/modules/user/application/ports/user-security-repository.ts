import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { SessionId, UserId } from '@/modules/kernel/domain/ids';

import type { UserRole } from '../../domain/user';

export type UserSecurityPrincipalRepositoryOutcome =
  | Readonly<{ role: UserRole; type: 'user_security_principal_found' }>
  | Readonly<{ type: 'user_security_principal_not_found' }>;

export type UserSecurityMutationPrincipalsRepositoryOutcome = Readonly<{
  actor: UserSecurityPrincipalRepositoryOutcome;
  target: UserSecurityPrincipalRepositoryOutcome;
  type: 'user_security_mutation_principals_locked';
}>;

export type UserDeletedRepositoryOutcome =
  | Readonly<{ type: 'user_deleted' }>
  | Readonly<{ type: 'user_not_found' }>;

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
  lockMutationPrincipals(input: {
    actorId: UserId;
    targetId: UserId;
  }): Promise<
    ApplicationResult<UserSecurityMutationPrincipalsRepositoryOutcome>
  >;
  deleteUser(
    userId: UserId
  ): Promise<ApplicationResult<UserDeletedRepositoryOutcome>>;
  revokeSessions(
    userId: UserId
  ): Promise<ApplicationResult<UserSessionsRevokedRepositoryOutcome>>;
  revokeSession(input: {
    sessionId: SessionId;
    userId: UserId;
  }): Promise<ApplicationResult<UserSessionRevokedRepositoryOutcome>>;
}
