import type { Logger } from '@/modules/kernel/application/ports/logger';
import type { PermissionChecker } from '@/modules/kernel/application/ports/permission-checker';
import type { ResultTransactionRunner } from '@/modules/kernel/application/ports/result-transaction-runner';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { AuditPort } from '@/modules/audit';

import type {
  UserCreateRepositoryOutcome,
  UserGetRepositoryOutcome,
  UserListRepositoryOutcome,
  UserRepository,
  UserSessionsListRepositoryOutcome,
  UserUpdateRepositoryOutcome,
} from '../ports/user-repository';
import type {
  UserSecurityRepository,
  UserSessionRevokedRepositoryOutcome,
} from '../ports/user-security-repository';

export type UserTransactionContext = {
  audit: AuditPort;
  securityRepository: UserSecurityRepository;
  userRepository: UserRepository;
};

export type UserUseCaseDeps = {
  userRepository: UserRepository;
  transactionRunner: ResultTransactionRunner<UserTransactionContext>;
  permissionChecker: PermissionChecker;
  logger: Logger;
};

export type UserForbiddenOutcome = { type: 'user_forbidden' };
export type UserSelfOutcome = { type: 'user_self' };

export type UserListOutcome = UserListRepositoryOutcome | UserForbiddenOutcome;

export type UserGetOutcome = UserGetRepositoryOutcome | UserForbiddenOutcome;

export type UserCreateOutcome =
  | UserCreateRepositoryOutcome
  | UserForbiddenOutcome;

export type UserUpdateOutcome =
  | UserUpdateRepositoryOutcome
  | UserForbiddenOutcome;

export type UserDeleteOutcome =
  | { type: 'user_deleted' }
  | { type: 'user_not_found' }
  | UserForbiddenOutcome
  | UserSelfOutcome;

export type UserSessionsListOutcome =
  | UserSessionsListRepositoryOutcome
  | UserForbiddenOutcome;

export type UserRevokeSessionsOutcome =
  | { type: 'user_sessions_revoked' }
  | { type: 'user_sessions_unchanged' }
  | UserForbiddenOutcome
  | UserSelfOutcome;

export type UserRevokeSessionOutcome =
  | { type: 'user_session_revoked' }
  | Extract<
      UserSessionRevokedRepositoryOutcome,
      { type: 'user_session_not_found' }
    >
  | UserForbiddenOutcome
  | UserSelfOutcome;

export type UserSignOutOutcome =
  | { type: 'user_signed_out' }
  | Extract<
      UserSessionRevokedRepositoryOutcome,
      { type: 'user_session_not_found' }
    >;

export type UserResult<TOutcome> = ApplicationResult<TOutcome>;
