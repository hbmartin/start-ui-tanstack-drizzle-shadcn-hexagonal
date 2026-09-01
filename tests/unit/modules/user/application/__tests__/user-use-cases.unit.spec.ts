import { Result } from '@bloodyowl/boxed';
import { testUserDisplayName } from '@tests/support/branded-values';
import { describe, expect, it, vi } from 'vitest';

import type { AuditPort } from '@/modules/audit';
import type {
  Logger,
  PermissionChecker,
  PermissionRequest,
  ResultTransactionRunner,
} from '@/modules/kernel';
import {
  AppError,
  toCorrelationId,
  toEmailAddress,
  toSessionId,
  toUserId,
} from '@/modules/kernel';
import type { ApplicationResult } from '@/modules/kernel/testing';
import { unwrapParseResult } from '@/modules/kernel/testing';
import {
  createUserUseCases,
  type User,
  type UserRepository,
  type UserSecurityRepository,
  type UserTransactionContext,
} from '@/modules/user/testing';

const now = new Date('2026-01-01T00:00:00.000Z');
const userId = unwrapParseResult(toUserId('user-1'));
const adminId = unwrapParseResult(toUserId('admin-1'));
const targetSessionId = unwrapParseResult(toSessionId('session-2'));
const currentSessionId = unwrapParseResult(toSessionId('current-session'));
const correlationId = unwrapParseResult(toCorrelationId('correlation-1'));
const user: User = {
  id: userId,
  name: testUserDisplayName('User'),
  email: unwrapParseResult(toEmailAddress('user@example.com')),
  emailVerified: true,
  role: 'user',
  image: null,
  createdAt: now,
  updatedAt: now,
  onboardedAt: null,
};

const userListPermission = {
  user: ['list'],
} as const satisfies PermissionRequest;
const userCreatePermission = {
  user: ['create'],
} as const satisfies PermissionRequest;
const userUpdatePermission = {
  user: ['update'],
} as const satisfies PermissionRequest;
const userSetRolePermission = {
  user: ['set-role'],
} as const satisfies PermissionRequest;
const userDeletePermission = {
  user: ['delete'],
} as const satisfies PermissionRequest;
const sessionListPermission = {
  session: ['list'],
} as const satisfies PermissionRequest;
const sessionRevokePermission = {
  session: ['revoke'],
} as const satisfies PermissionRequest;

function samePermissionRequest(
  expected: PermissionRequest,
  actual: PermissionRequest
) {
  const expectedEntries = Object.entries(expected);
  const actualEntries = Object.entries(actual);
  return (
    expectedEntries.length === actualEntries.length &&
    expectedEntries.every(([resource, actions]) => {
      const actualActions = actual[resource];
      return (
        actualActions !== undefined &&
        actions.length === actualActions.length &&
        actions.every((action, index) => action === actualActions[index])
      );
    })
  );
}

function makePermissionChecker(
  ...allowedRequests: PermissionRequest[]
): PermissionChecker {
  return {
    hasPermission: vi.fn<PermissionChecker['hasPermission']>(
      async (_userId, permissions) => {
        const allowed = allowedRequests.some((request) =>
          samePermissionRequest(request, permissions)
        );
        return Result.Ok({
          type: allowed ? 'permission_granted' : 'permission_denied',
        });
      }
    ),
  };
}

function makeLogger(): Logger {
  return {
    debug: vi.fn<Logger['debug']>(),
    info: vi.fn<Logger['info']>(),
    warn: vi.fn<Logger['warn']>(),
    error: vi.fn<Logger['error']>(),
  };
}

function makeRepo(overrides: Partial<UserRepository> = {}) {
  const repo = {
    list: vi.fn<UserRepository['list']>(async () =>
      Result.Ok({
        type: 'user_listed',
        page: {
          items: [user],
          total: 1,
        },
      })
    ),
    getById: vi.fn<UserRepository['getById']>(async () =>
      Result.Ok({ type: 'user_found', user })
    ),
    create: vi.fn<UserRepository['create']>(async (input) =>
      Result.Ok({
        type: 'user_created',
        user: {
          ...user,
          name: input.name ?? user.name,
          email: input.email,
          role: input.role ?? user.role,
        },
      })
    ),
    getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(async () =>
      Result.Ok({
        type: 'user_update_snapshot_found',
        snapshot: {
          email: unwrapParseResult(toEmailAddress('old@example.com')),
          role: 'user',
        },
      })
    ),
    update: vi.fn<UserRepository['update']>(async (_id, input) =>
      Result.Ok({
        type: 'user_updated',
        user: {
          ...user,
          name: input.name ?? user.name,
          email: input.email,
          role: input.role ?? user.role,
          emailVerified: input.emailVerified ?? user.emailVerified,
        },
      })
    ),
    listSessions: vi.fn<UserRepository['listSessions']>(async () =>
      Result.Ok({
        type: 'user_sessions_listed',
        page: {
          items: [
            {
              id: targetSessionId,
              createdAt: now,
              updatedAt: now,
              expiresAt: now,
              ipAddress: null,
              userAgent: null,
            },
          ],
          total: 1,
        },
      })
    ),
  };

  return Object.assign(repo, overrides);
}

function makeSecurityRepository(
  overrides: Partial<UserSecurityRepository> = {}
) {
  const repository = {
    lockAuthorizationPrincipal: vi.fn<
      UserSecurityRepository['lockAuthorizationPrincipal']
    >(async () =>
      Result.Ok({ type: 'user_security_principal_found', role: 'admin' })
    ),
    lockMutationPrincipals: vi.fn<
      UserSecurityRepository['lockMutationPrincipals']
    >(async () =>
      Result.Ok({
        type: 'user_security_mutation_principals_locked',
        actor: { type: 'user_security_principal_found', role: 'admin' },
        target: {
          type: 'user_security_principal_found',
          role: user.role,
        },
      })
    ),
    deleteUser: vi.fn<UserSecurityRepository['deleteUser']>(async () =>
      Result.Ok({ type: 'user_deleted' })
    ),
    revokeSessions: vi.fn<UserSecurityRepository['revokeSessions']>(async () =>
      Result.Ok({ type: 'user_sessions_revoked', count: 1 })
    ),
    revokeSession: vi.fn<UserSecurityRepository['revokeSession']>(async () =>
      Result.Ok({ type: 'user_session_revoked' })
    ),
  };

  return Object.assign(repository, overrides);
}

function makeAudit(overrides: Partial<AuditPort> = {}) {
  const audit = {
    record: vi.fn<AuditPort['record']>(async () =>
      Result.Ok({
        type: 'audit_recorded',
        eventId: 'audit-1' as never,
        occurredAt: now,
      })
    ),
  };

  return Object.assign(audit, overrides);
}

function makeContext(
  overrides: {
    repo?: Partial<UserRepository>;
    permissionChecker?: PermissionChecker;
    securityRepository?: Partial<UserSecurityRepository>;
    audit?: Partial<AuditPort>;
    transactionRunner?: ResultTransactionRunner<UserTransactionContext>;
  } = {}
) {
  const repo = makeRepo(overrides.repo);
  const securityRepository = makeSecurityRepository(
    overrides.securityRepository
  );
  const audit = makeAudit(overrides.audit);
  const permissionChecker =
    overrides.permissionChecker ?? makePermissionChecker();
  const logger = makeLogger();
  const transactionRunner =
    overrides.transactionRunner ??
    ({
      async run(work) {
        return work({ audit, securityRepository, userRepository: repo });
      },
    } satisfies ResultTransactionRunner<UserTransactionContext>);
  const useCases = createUserUseCases({
    userRepository: repo,
    transactionRunner,
    permissionChecker,
    logger,
  });

  return {
    useCases,
    repo,
    audit,
    securityRepository,
    transactionRunner,
    permissionChecker,
    logger,
  };
}

function appError(code: string) {
  return new AppError({
    code,
    category: 'conflict',
    status: 409,
  });
}

async function expectOk<TOutcome extends { type: string }>(
  promise: Promise<ApplicationResult<TOutcome>>
) {
  const result = await promise;
  if (result.isError()) throw result.getError();
  return result.get();
}

async function expectFailure<TOutcome extends { type: string }>(
  promise: Promise<ApplicationResult<TOutcome>>
) {
  const result = await promise;
  if (result.isOk()) {
    throw new Error(`Expected Result.Error, got ${result.get().type}`);
  }
  return result.getError();
}

describe('user use cases', () => {
  describe('list', () => {
    it('lists users after checking the exact user list permission', async () => {
      const cursor = unwrapParseResult(toUserId('cursor-1'));
      const { useCases, repo, permissionChecker, logger } = makeContext({
        permissionChecker: makePermissionChecker(userListPermission),
      });

      await expect(
        expectOk(
          useCases.list({
            currentUserId: adminId,
            cursor,
            limit: 20,
            searchTerm: 'alice',
          })
        )
      ).resolves.toEqual({
        type: 'user_listed',
        page: { items: [user], total: 1 },
      });

      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        adminId,
        userListPermission
      );
      expect(repo.list).toHaveBeenCalledWith({
        cursor,
        limit: 20,
        searchTerm: 'alice',
      });
      expect(logger.info).toHaveBeenCalledWith({ event: 'user.list' });
    });

    it('does not list users without permission', async () => {
      const { useCases, repo, logger } = makeContext({
        permissionChecker: makePermissionChecker(),
      });

      await expect(
        expectOk(
          useCases.list({
            currentUserId: adminId,
            limit: 20,
            searchTerm: '',
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(repo.list).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('get', () => {
    it('gets a user after checking the exact user list permission', async () => {
      const { useCases, repo, permissionChecker, logger } = makeContext({
        permissionChecker: makePermissionChecker(userListPermission),
      });

      await expect(
        expectOk(useCases.get({ currentUserId: adminId, id: userId }))
      ).resolves.toEqual({ type: 'user_found', user });

      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        adminId,
        userListPermission
      );
      expect(repo.getById).toHaveBeenCalledWith(userId);
      expect(logger.info).toHaveBeenCalledWith({
        event: 'user.get',
        details: { userId },
      });
    });

    it('does not get users without permission', async () => {
      const { useCases, repo, logger } = makeContext({
        permissionChecker: makePermissionChecker(),
      });

      await expect(
        expectOk(useCases.get({ currentUserId: adminId, id: userId }))
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(repo.getById).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('returns not_found when the user row is missing', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(userListPermission),
        repo: {
          getById: vi.fn<UserRepository['getById']>(async () =>
            Result.Ok({ type: 'user_not_found' })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.get({
            currentUserId: adminId,
            id: unwrapParseResult(toUserId('missing')),
          })
        )
      ).resolves.toEqual({ type: 'user_not_found' });
    });
  });

  describe('create', () => {
    it('creates users after checking the exact create permission', async () => {
      const input = {
        name: testUserDisplayName('New User'),
        email: unwrapParseResult(toEmailAddress('new@example.com')),
        role: 'admin' as const,
      };
      const { useCases, repo, permissionChecker, logger } = makeContext({
        // Creating an admin is a privileged role assignment, so the create flow
        // also requires user:set-role (see the dedicated gate tests below).
        permissionChecker: makePermissionChecker(
          userCreatePermission,
          userSetRolePermission
        ),
      });

      await expect(
        expectOk(useCases.create({ currentUserId: adminId, user: input }))
      ).resolves.toMatchObject({
        type: 'user_created',
        user: {
          name: testUserDisplayName('New User'),
          email: unwrapParseResult(toEmailAddress('new@example.com')),
          role: 'admin',
        },
      });

      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        adminId,
        userCreatePermission
      );
      expect(repo.create).toHaveBeenCalledWith(input);
      expect(logger.info).toHaveBeenCalledWith({ event: 'user.create' });
    });

    it('does not create users without permission', async () => {
      const { useCases, repo, logger } = makeContext({
        permissionChecker: makePermissionChecker(),
      });

      await expect(
        expectOk(
          useCases.create({
            currentUserId: adminId,
            user: {
              email: unwrapParseResult(toEmailAddress('new@example.com')),
              role: 'user',
            },
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(repo.create).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('maps duplicate email conflicts', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(userCreatePermission),
        repo: {
          create: vi.fn<UserRepository['create']>(async () =>
            Result.Ok({ type: 'user_duplicate' })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.create({
            currentUserId: adminId,
            user: {
              email: unwrapParseResult(toEmailAddress('user@example.com')),
              role: 'user',
            },
          })
        )
      ).resolves.toEqual({ type: 'user_duplicate' });
    });

    it('returns non-duplicate create conflicts as app errors', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(userCreatePermission),
        repo: {
          create: vi.fn<UserRepository['create']>(async () =>
            Result.Error(appError('OTHER_CONFLICT'))
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.create({
            currentUserId: adminId,
            user: {
              email: unwrapParseResult(toEmailAddress('user@example.com')),
              role: 'user',
            },
          })
        )
      ).resolves.toMatchObject({ code: 'OTHER_CONFLICT' });
    });

    it('does not create a privileged user when set-role is denied', async () => {
      const { useCases, repo, permissionChecker } = makeContext({
        permissionChecker: makePermissionChecker(userCreatePermission),
      });

      await expect(
        expectOk(
          useCases.create({
            currentUserId: adminId,
            user: {
              email: unwrapParseResult(toEmailAddress('new@example.com')),
              role: 'admin',
            },
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(permissionChecker.hasPermission).toHaveBeenNthCalledWith(
        1,
        adminId,
        userCreatePermission
      );
      expect(permissionChecker.hasPermission).toHaveBeenNthCalledWith(
        2,
        adminId,
        userSetRolePermission
      );
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('creates a privileged user when both create and set-role are granted', async () => {
      const input = {
        name: testUserDisplayName('New Admin'),
        email: unwrapParseResult(toEmailAddress('admin2@example.com')),
        role: 'admin' as const,
      };
      const { useCases, repo, permissionChecker } = makeContext({
        permissionChecker: makePermissionChecker(
          userCreatePermission,
          userSetRolePermission
        ),
      });

      await expect(
        expectOk(useCases.create({ currentUserId: adminId, user: input }))
      ).resolves.toMatchObject({
        type: 'user_created',
        user: { role: 'admin' },
      });

      expect(permissionChecker.hasPermission).toHaveBeenNthCalledWith(
        1,
        adminId,
        userCreatePermission
      );
      expect(permissionChecker.hasPermission).toHaveBeenNthCalledWith(
        2,
        adminId,
        userSetRolePermission
      );
      expect(repo.create).toHaveBeenCalledWith(input);
    });

    it('creates a default-role user without consulting set-role', async () => {
      const { useCases, repo, permissionChecker } = makeContext({
        permissionChecker: makePermissionChecker(userCreatePermission),
      });

      await expect(
        expectOk(
          useCases.create({
            currentUserId: adminId,
            user: {
              email: unwrapParseResult(toEmailAddress('member@example.com')),
            },
          })
        )
      ).resolves.toMatchObject({
        type: 'user_created',
        user: { role: 'user' },
      });

      expect(permissionChecker.hasPermission).toHaveBeenCalledTimes(1);
      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        adminId,
        userCreatePermission
      );
      expect(repo.create).toHaveBeenCalledWith({
        email: unwrapParseResult(toEmailAddress('member@example.com')),
      });
    });
  });

  describe('update', () => {
    it('does not load snapshots without update permission', async () => {
      const { useCases, repo } = makeContext({
        permissionChecker: makePermissionChecker(),
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: {
              email: unwrapParseResult(toEmailAddress('next@example.com')),
            },
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(repo.getUpdateSnapshot).not.toHaveBeenCalled();
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('returns not_found when the update snapshot is missing', async () => {
      const { useCases, repo } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () => Result.Ok({ type: 'user_not_found' })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: unwrapParseResult(toUserId('missing')),
            user: {
              email: unwrapParseResult(toEmailAddress('next@example.com')),
            },
          })
        )
      ).resolves.toEqual({ type: 'user_not_found' });

      expect(repo.update).not.toHaveBeenCalled();
    });

    it('updates self without applying submitted role changes', async () => {
      const nextEmail = unwrapParseResult(toEmailAddress('next@example.com'));
      const { useCases, repo, permissionChecker, logger } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: userId,
            id: userId,
            user: { email: nextEmail, role: 'admin' },
          })
        )
      ).resolves.toMatchObject({
        type: 'user_updated',
        user: { email: nextEmail, role: 'user', emailVerified: false },
      });

      expect(permissionChecker.hasPermission).toHaveBeenCalledTimes(1);
      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        userId,
        userUpdatePermission
      );
      expect(repo.update).toHaveBeenCalledWith(userId, {
        email: nextEmail,
        role: undefined,
        emailVerified: false,
      });
      expect(logger.info).toHaveBeenCalledWith({
        event: 'user.update',
        details: { userId },
      });
    });

    it('requires set-role permission before changing another user role', async () => {
      const { useCases, repo, permissionChecker } = makeContext({
        permissionChecker: makePermissionChecker(
          userUpdatePermission,
          userSetRolePermission
        ),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () =>
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: {
                  email: user.email,
                  role: 'user',
                },
              })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: {
              name: testUserDisplayName('Updated User'),
              email: user.email,
              role: 'admin',
            },
          })
        )
      ).resolves.toMatchObject({
        type: 'user_updated',
        user: {
          name: testUserDisplayName('Updated User'),
          role: 'admin',
          emailVerified: true,
        },
      });

      expect(permissionChecker.hasPermission).toHaveBeenNthCalledWith(
        1,
        adminId,
        userUpdatePermission
      );
      expect(permissionChecker.hasPermission).toHaveBeenNthCalledWith(
        2,
        adminId,
        userSetRolePermission
      );
      expect(repo.update).toHaveBeenCalledWith(userId, {
        email: user.email,
        role: 'admin',
        emailVerified: undefined,
        name: testUserDisplayName('Updated User'),
      });
    });

    it('does not update another user role when set-role is denied', async () => {
      const { useCases, repo, permissionChecker } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () =>
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: {
                  email: user.email,
                  role: 'user',
                },
              })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: { email: user.email, role: 'admin' },
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(permissionChecker.hasPermission).toHaveBeenCalledTimes(2);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('does not require set-role or revoke sessions for an unchanged submitted role', async () => {
      const { useCases, repo, permissionChecker } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () =>
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: {
                  email: user.email,
                  role: 'user',
                },
              })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: { email: user.email, role: 'user' },
          })
        )
      ).resolves.toMatchObject({
        type: 'user_updated',
        user: { role: 'user' },
      });

      expect(permissionChecker.hasPermission).toHaveBeenCalledTimes(1);
      expect(permissionChecker.hasPermission).toHaveBeenNthCalledWith(
        1,
        adminId,
        userUpdatePermission
      );
      expect(repo.update).toHaveBeenCalledWith(userId, {
        email: user.email,
        role: undefined,
        emailVerified: undefined,
      });
    });

    it('revokes the target sessions after a role change so the cached role is evicted', async () => {
      const { useCases, audit, logger, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(
          userUpdatePermission,
          userSetRolePermission
        ),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () =>
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: { email: user.email, role: 'admin' },
              })
          ),
        },
      });

      const outcome = await expectOk(
        useCases.update({
          correlationId,
          currentUserId: adminId,
          id: userId,
          user: { email: user.email, role: 'user' },
        })
      );
      expect(outcome).toMatchObject({ type: 'user_updated' });

      expect(securityRepository.revokeSessions).toHaveBeenCalledWith(userId);
      expect(audit.record).toHaveBeenNthCalledWith(1, {
        type: 'authorization.role-changed',
        actor: { kind: 'user', userId: adminId },
        subject: { kind: 'user', id: userId },
        correlationId,
        metadata: { from: 'admin', to: 'user' },
      });
      expect(audit.record).toHaveBeenNthCalledWith(2, {
        type: 'session.revoked',
        actor: { kind: 'user', userId: adminId },
        subject: { kind: 'user', id: userId },
        correlationId,
        metadata: { reason: 'role-change', scope: 'all' },
      });
      expect(logger.warn).toHaveBeenCalledWith({
        event: 'security.session_revoked',
        correlationId,
        details: {
          mode: 'all',
          reason: 'role_changed',
          revokedByUserId: adminId,
          targetUserId: userId,
          count: 1,
        },
      });
    });

    it('does not emit a revocation audit or signal when a role change finds no sessions', async () => {
      const { useCases, audit, logger, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(
          userUpdatePermission,
          userSetRolePermission
        ),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () =>
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: { email: user.email, role: 'user' },
              })
          ),
        },
        securityRepository: {
          revokeSessions: vi.fn<UserSecurityRepository['revokeSessions']>(
            async () => Result.Ok({ type: 'user_sessions_revoked', count: 0 })
          ),
        },
      });

      await expectOk(
        useCases.update({
          correlationId,
          currentUserId: adminId,
          id: userId,
          user: { email: user.email, role: 'admin' },
        })
      );

      expect(securityRepository.revokeSessions).toHaveBeenCalledWith(userId);
      expect(audit.record).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'authorization.role-changed' })
      );
      expect(logger.warn).not.toHaveBeenCalled();
    });

    it('uses the locked role as authoritative when the outer snapshot is stale', async () => {
      const { useCases, audit, repo, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(
          userUpdatePermission,
          userSetRolePermission
        ),
        repo: {
          getUpdateSnapshot: vi
            .fn<UserRepository['getUpdateSnapshot']>()
            .mockResolvedValueOnce(
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: { email: user.email, role: 'admin' },
              })
            )
            .mockResolvedValueOnce(
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: { email: user.email, role: 'user' },
              })
            ),
        },
      });

      await expectOk(
        useCases.update({
          correlationId,
          currentUserId: adminId,
          id: userId,
          user: {
            email: user.email,
            name: testUserDisplayName('Durable Name'),
            role: 'user',
          },
        })
      );

      expect(repo.update).toHaveBeenCalledWith(userId, {
        email: user.email,
        emailVerified: undefined,
        name: testUserDisplayName('Durable Name'),
        role: undefined,
      });
      expect(securityRepository.revokeSessions).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('locks actor and target through one ordered repository operation', async () => {
      const { useCases, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(
          userUpdatePermission,
          userSetRolePermission
        ),
      });

      await expectOk(
        useCases.update({
          correlationId,
          currentUserId: adminId,
          id: userId,
          user: { email: user.email, role: 'admin' },
        })
      );

      expect(securityRepository.lockMutationPrincipals).toHaveBeenCalledOnce();
      expect(securityRepository.lockMutationPrincipals).toHaveBeenCalledWith({
        actorId: adminId,
        targetId: userId,
      });
    });

    it('does not revoke sessions when no role write is submitted', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () =>
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: { email: user.email, role: 'user' },
              })
          ),
        },
      });

      const outcome = await expectOk(
        useCases.update({
          correlationId,
          currentUserId: adminId,
          id: userId,
          user: { email: user.email, role: 'user' },
        })
      );
      expect(outcome).toMatchObject({ type: 'user_updated' });
    });

    it('surfaces a post-role-change session-revoke failure as an app error', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(
          userUpdatePermission,
          userSetRolePermission
        ),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () =>
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: { email: user.email, role: 'admin' },
              })
          ),
        },
        securityRepository: {
          revokeSessions: vi.fn<UserSecurityRepository['revokeSessions']>(
            async () =>
              Result.Error(
                new AppError({
                  code: 'USER_SESSIONS_REVOKE_FAILED',
                  category: 'system',
                  status: 500,
                  message: 'Failed to revoke user sessions',
                })
              )
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: { email: user.email, role: 'user' },
          })
        )
      ).resolves.toMatchObject({ code: 'USER_SESSIONS_REVOKE_FAILED' });
    });

    it('normalizes a null display name to an empty string', async () => {
      const { useCases, repo } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
        repo: {
          getUpdateSnapshot: vi.fn<UserRepository['getUpdateSnapshot']>(
            async () =>
              Result.Ok({
                type: 'user_update_snapshot_found',
                snapshot: {
                  email: user.email,
                  role: 'user',
                },
              })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: { name: null, email: user.email },
          })
        )
      ).resolves.toMatchObject({
        type: 'user_updated',
        user: { name: testUserDisplayName('') },
      });

      expect(repo.update).toHaveBeenCalledWith(userId, {
        email: user.email,
        role: undefined,
        emailVerified: undefined,
        name: testUserDisplayName(''),
      });
    });

    it('returns not_found when the update write misses after a snapshot', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
        repo: {
          update: vi.fn<UserRepository['update']>(async () =>
            Result.Ok({ type: 'user_not_found' })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: { email: user.email },
          })
        )
      ).resolves.toEqual({ type: 'user_not_found' });
    });

    it('maps duplicate email conflicts', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
        repo: {
          update: vi.fn<UserRepository['update']>(async () =>
            Result.Ok({ type: 'user_duplicate' })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: {
              email: unwrapParseResult(toEmailAddress('duplicate@example.com')),
            },
          })
        )
      ).resolves.toEqual({ type: 'user_duplicate' });
    });

    it('returns non-duplicate update conflicts as app errors', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(userUpdatePermission),
        repo: {
          update: vi.fn<UserRepository['update']>(async () =>
            Result.Error(appError('OTHER_CONFLICT'))
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.update({
            correlationId,
            currentUserId: adminId,
            id: userId,
            user: {
              email: unwrapParseResult(toEmailAddress('duplicate@example.com')),
            },
          })
        )
      ).resolves.toMatchObject({ code: 'OTHER_CONFLICT' });
    });
  });

  describe('delete', () => {
    it('deletes another user after checking the exact delete permission', async () => {
      const { useCases, audit, permissionChecker, logger, securityRepository } =
        makeContext({
          permissionChecker: makePermissionChecker(userDeletePermission),
        });

      await expect(
        expectOk(
          useCases.delete({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_deleted' });

      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        adminId,
        userDeletePermission
      );
      expect(securityRepository.lockMutationPrincipals).toHaveBeenCalledWith({
        actorId: adminId,
        targetId: userId,
      });
      expect(securityRepository.deleteUser).toHaveBeenCalledWith(userId);
      expect(audit.record).toHaveBeenCalledWith({
        type: 'administration.user-deleted',
        actor: { kind: 'user', userId: adminId },
        subject: { kind: 'user', id: userId },
        correlationId,
        metadata: { reason: 'administrator' },
      });
      expect(logger.info).toHaveBeenCalledWith({
        event: 'user.delete',
        correlationId,
        details: { deletedByUserId: adminId, userId },
      });
    });

    it('does not delete users without permission', async () => {
      const { useCases, logger, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(),
      });

      await expect(
        expectOk(
          useCases.delete({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(securityRepository.deleteUser).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });

    it('does not delete the current user', async () => {
      const { useCases, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(userDeletePermission),
      });

      await expect(
        expectOk(
          useCases.delete({
            correlationId,
            currentUserId: userId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_self' });

      expect(securityRepository.deleteUser).not.toHaveBeenCalled();
    });

    it('reports a missing durable target without deleting or auditing', async () => {
      const { useCases, audit, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(userDeletePermission),
        securityRepository: {
          lockMutationPrincipals: vi.fn<
            UserSecurityRepository['lockMutationPrincipals']
          >(async () =>
            Result.Ok({
              type: 'user_security_mutation_principals_locked',
              actor: { type: 'user_security_principal_found', role: 'admin' },
              target: { type: 'user_security_principal_not_found' },
            })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.delete({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_not_found' });

      expect(securityRepository.deleteUser).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('rejects deletion when the durable actor was demoted', async () => {
      const { useCases, audit, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(userDeletePermission),
        securityRepository: {
          lockMutationPrincipals: vi.fn<
            UserSecurityRepository['lockMutationPrincipals']
          >(async () =>
            Result.Ok({
              type: 'user_security_mutation_principals_locked',
              actor: { type: 'user_security_principal_found', role: 'user' },
              target: { type: 'user_security_principal_found', role: 'user' },
            })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.delete({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(securityRepository.deleteUser).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('returns durable delete failures as app errors', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(userDeletePermission),
        securityRepository: {
          deleteUser: vi.fn<UserSecurityRepository['deleteUser']>(async () =>
            Result.Error(
              new AppError({
                code: 'USER_DELETE_FAILED',
                category: 'system',
                status: 500,
                message: 'Failed to delete user',
              })
            )
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.delete({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toMatchObject({
        code: 'USER_DELETE_FAILED',
        message: 'Failed to delete user',
      });
    });

    it('fails closed when the required deletion audit is not recorded', async () => {
      const { useCases, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(userDeletePermission),
        audit: {
          record: vi.fn<AuditPort['record']>(async () =>
            Result.Ok({
              type: 'audit_best_effort_failed',
              eventType: 'administration.user-deleted',
              operationalSignalAttempted: true,
            })
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.delete({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toMatchObject({
        code: 'REQUIRED_AUDIT_EVENT_NOT_RECORDED',
      });

      expect(securityRepository.deleteUser).toHaveBeenCalledWith(userId);
    });
  });

  describe('listSessions', () => {
    it('lists sessions after checking the exact session list permission', async () => {
      const cursor = unwrapParseResult(toSessionId('cursor-session'));
      const { useCases, repo, permissionChecker, logger } = makeContext({
        permissionChecker: makePermissionChecker(sessionListPermission),
      });

      await expect(
        expectOk(
          useCases.listSessions({
            currentUserId: adminId,
            userId,
            cursor,
            limit: 10,
          })
        )
      ).resolves.toEqual({
        type: 'user_sessions_listed',
        page: {
          items: [
            {
              id: targetSessionId,
              createdAt: now,
              updatedAt: now,
              expiresAt: now,
              ipAddress: null,
              userAgent: null,
            },
          ],
          total: 1,
        },
      });

      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        adminId,
        sessionListPermission
      );
      expect(repo.listSessions).toHaveBeenCalledWith({
        userId,
        cursor,
        limit: 10,
      });
      expect(logger.info).toHaveBeenCalledWith({
        event: 'user.sessions.list',
        details: { userId },
      });
    });

    it('does not list sessions without permission', async () => {
      const { useCases, repo, logger } = makeContext({
        permissionChecker: makePermissionChecker(),
      });

      await expect(
        expectOk(
          useCases.listSessions({
            currentUserId: adminId,
            userId,
            limit: 10,
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(repo.listSessions).not.toHaveBeenCalled();
      expect(logger.info).not.toHaveBeenCalled();
    });
  });

  describe('revokeSessions', () => {
    it('revokes all durable sessions and records the required audit event', async () => {
      const { useCases, audit, securityRepository, permissionChecker } =
        makeContext({
          permissionChecker: makePermissionChecker(sessionRevokePermission),
        });

      await expect(
        expectOk(
          useCases.revokeSessions({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_sessions_revoked' });

      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        adminId,
        sessionRevokePermission
      );
      expect(securityRepository.revokeSessions).toHaveBeenCalledWith(userId);
      expect(audit.record).toHaveBeenCalledWith({
        type: 'session.revoked',
        actor: { kind: 'user', userId: adminId },
        subject: { kind: 'user', id: userId },
        correlationId,
        metadata: { reason: 'administrator', scope: 'all' },
      });
    });

    it('does not emit a completion audit when there are no sessions', async () => {
      const { useCases, audit } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
        securityRepository: {
          revokeSessions: vi.fn<UserSecurityRepository['revokeSessions']>(
            async () => Result.Ok({ type: 'user_sessions_revoked', count: 0 })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.revokeSessions({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_sessions_unchanged' });

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('does not revoke sessions without permission', async () => {
      const { useCases, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(),
      });

      await expect(
        expectOk(
          useCases.revokeSessions({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(securityRepository.revokeSessions).not.toHaveBeenCalled();
    });

    it('rechecks the actor role under the mutation transaction lock', async () => {
      const { useCases, audit, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
        securityRepository: {
          lockAuthorizationPrincipal: vi.fn<
            UserSecurityRepository['lockAuthorizationPrincipal']
          >(async () =>
            Result.Ok({
              type: 'user_security_principal_found',
              role: 'user',
            })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.revokeSessions({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(
        securityRepository.lockAuthorizationPrincipal
      ).toHaveBeenCalledWith(adminId);
      expect(securityRepository.revokeSessions).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('does not revoke the current user sessions through the admin flow', async () => {
      const { useCases, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
      });

      await expect(
        expectOk(
          useCases.revokeSessions({
            correlationId,
            currentUserId: userId,
            id: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_self' });

      expect(securityRepository.revokeSessions).not.toHaveBeenCalled();
    });

    it('returns durable revoke-all failures as app errors', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
        securityRepository: {
          revokeSessions: vi.fn<UserSecurityRepository['revokeSessions']>(
            async () =>
              Result.Error(
                new AppError({
                  code: 'USER_SESSIONS_REVOKE_FAILED',
                  category: 'system',
                  status: 500,
                  message: 'Failed to revoke user sessions',
                })
              )
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.revokeSessions({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toMatchObject({
        code: 'USER_SESSIONS_REVOKE_FAILED',
        message: 'Failed to revoke user sessions',
      });
    });

    it('fails closed when the required audit event cannot be recorded', async () => {
      const auditError = new AppError({
        code: 'AUDIT_RECORDING_FAILED',
        category: 'system',
        status: 500,
      });
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
        audit: {
          record: vi.fn<AuditPort['record']>(async () =>
            Result.Error(auditError)
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.revokeSessions({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toBe(auditError);
    });

    it('rejects an impossible best-effort outcome for a required event', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
        audit: {
          record: vi.fn<AuditPort['record']>(async () =>
            Result.Ok({
              type: 'audit_best_effort_failed',
              eventType: 'session.revoked',
              operationalSignalAttempted: true,
            })
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.revokeSessions({
            correlationId,
            currentUserId: adminId,
            id: userId,
          })
        )
      ).resolves.toMatchObject({ code: 'REQUIRED_AUDIT_EVENT_NOT_RECORDED' });
    });
  });

  describe('revokeSession', () => {
    it('revokes one durable session and records the required audit event', async () => {
      const { useCases, audit, securityRepository, permissionChecker } =
        makeContext({
          permissionChecker: makePermissionChecker(sessionRevokePermission),
        });

      await expect(
        expectOk(
          useCases.revokeSession({
            correlationId,
            currentUserId: adminId,
            currentSessionId,
            id: userId,
            sessionId: targetSessionId,
          })
        )
      ).resolves.toEqual({ type: 'user_session_revoked' });

      expect(permissionChecker.hasPermission).toHaveBeenCalledWith(
        adminId,
        sessionRevokePermission
      );
      expect(securityRepository.revokeSession).toHaveBeenCalledWith({
        userId,
        sessionId: targetSessionId,
      });
      expect(audit.record).toHaveBeenCalledWith({
        type: 'session.revoked',
        actor: { kind: 'user', userId: adminId },
        subject: { kind: 'session', id: targetSessionId },
        correlationId,
        metadata: { reason: 'administrator', scope: 'single' },
      });
    });

    it('does not revoke one session without permission', async () => {
      const { useCases, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(),
      });

      await expect(
        expectOk(
          useCases.revokeSession({
            correlationId,
            currentUserId: adminId,
            currentSessionId,
            id: userId,
            sessionId: targetSessionId,
          })
        )
      ).resolves.toEqual({ type: 'user_forbidden' });

      expect(securityRepository.revokeSession).not.toHaveBeenCalled();
    });

    it('returns not_found without an audit when no durable session exists', async () => {
      const { useCases, audit } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
        securityRepository: {
          revokeSession: vi.fn<UserSecurityRepository['revokeSession']>(
            async () => Result.Ok({ type: 'user_session_not_found' })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.revokeSession({
            correlationId,
            currentUserId: adminId,
            currentSessionId,
            id: userId,
            sessionId: targetSessionId,
          })
        )
      ).resolves.toEqual({ type: 'user_session_not_found' });

      expect(audit.record).not.toHaveBeenCalled();
    });

    it('does not revoke the current browser session', async () => {
      const { useCases, securityRepository } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
      });

      await expect(
        expectOk(
          useCases.revokeSession({
            correlationId,
            currentUserId: adminId,
            currentSessionId: targetSessionId,
            id: userId,
            sessionId: targetSessionId,
          })
        )
      ).resolves.toEqual({ type: 'user_self' });

      expect(securityRepository.revokeSession).not.toHaveBeenCalled();
    });

    it('returns durable revoke-one failures as app errors', async () => {
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
        securityRepository: {
          revokeSession: vi.fn<UserSecurityRepository['revokeSession']>(
            async () =>
              Result.Error(
                new AppError({
                  code: 'USER_SESSION_REVOKE_FAILED',
                  category: 'system',
                  status: 500,
                  message: 'Failed to revoke user session',
                })
              )
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.revokeSession({
            correlationId,
            currentUserId: adminId,
            currentSessionId,
            id: userId,
            sessionId: targetSessionId,
          })
        )
      ).resolves.toMatchObject({
        code: 'USER_SESSION_REVOKE_FAILED',
        message: 'Failed to revoke user session',
      });
    });

    it('fails closed when the single-session audit cannot be recorded', async () => {
      const auditError = new AppError({
        code: 'AUDIT_RECORDING_FAILED',
        category: 'system',
        status: 500,
      });
      const { useCases } = makeContext({
        permissionChecker: makePermissionChecker(sessionRevokePermission),
        audit: {
          record: vi.fn<AuditPort['record']>(async () =>
            Result.Error(auditError)
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.revokeSession({
            correlationId,
            currentUserId: adminId,
            currentSessionId,
            id: userId,
            sessionId: targetSessionId,
          })
        )
      ).resolves.toBe(auditError);
    });
  });

  describe('signOutCurrentSession', () => {
    it('revokes the current durable session and records the required auth event', async () => {
      const { useCases, audit, logger, securityRepository } = makeContext();

      await expect(
        expectOk(
          useCases.signOutCurrentSession({
            correlationId,
            currentSessionId,
            currentUserId: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_signed_out' });

      expect(securityRepository.revokeSession).toHaveBeenCalledWith({
        sessionId: currentSessionId,
        userId,
      });
      expect(audit.record).toHaveBeenCalledWith({
        type: 'authentication.signed-out',
        actor: { kind: 'user', userId },
        subject: { kind: 'session', id: currentSessionId },
        correlationId,
        metadata: { scope: 'current-session' },
      });
      expect(logger.info).toHaveBeenCalledWith({
        event: 'authentication.signed_out',
        correlationId,
        details: { sessionId: currentSessionId, userId },
      });
    });

    it('does not audit a current session that is already gone', async () => {
      const { useCases, audit } = makeContext({
        securityRepository: {
          revokeSession: vi.fn<UserSecurityRepository['revokeSession']>(
            async () => Result.Ok({ type: 'user_session_not_found' })
          ),
        },
      });

      await expect(
        expectOk(
          useCases.signOutCurrentSession({
            correlationId,
            currentSessionId,
            currentUserId: userId,
          })
        )
      ).resolves.toEqual({ type: 'user_session_not_found' });
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('fails closed when the signed-out audit cannot be recorded', async () => {
      const auditError = new AppError({
        code: 'AUDIT_RECORDING_FAILED',
        category: 'system',
        status: 500,
      });
      const { useCases } = makeContext({
        audit: {
          record: vi.fn<AuditPort['record']>(async () =>
            Result.Error(auditError)
          ),
        },
      });

      await expect(
        expectFailure(
          useCases.signOutCurrentSession({
            correlationId,
            currentSessionId,
            currentUserId: userId,
          })
        )
      ).resolves.toBe(auditError);
    });
  });
});
