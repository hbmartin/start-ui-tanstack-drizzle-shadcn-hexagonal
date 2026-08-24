import { Result } from '@bloodyowl/boxed';
import { makeSessionRow, makeUserRow } from '@tests/server/db-fixtures';
import { createPgliteTestDatabase } from '@tests/server/pglite';
import { eq } from 'drizzle-orm';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import type { AuditPort } from '@/modules/audit';
import {
  createAuditPort,
  createAuditRepository,
  createLoggerAuditFailureSignal,
} from '@/modules/audit/backend';
import { auditEvent as auditEventTable } from '@/modules/audit/persistence';
import {
  type Auth,
  createUserRepository,
  createUserSecurityRepository,
  SessionGatewayBetterAuth,
} from '@/modules/auth/testing';
import {
  AppError,
  type ApplicationResult,
  toCorrelationId,
  toEmailAddress,
  toGeneratedId,
  toSessionId,
  toUserId,
} from '@/modules/kernel';
import {
  createResultTransactionRunner,
  createTransactionRunner,
} from '@/modules/kernel/backend';
import {
  authIdentity,
  session as sessionTable,
  user as userTable,
} from '@/modules/kernel/infrastructure/db/schema';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';
import type { Database } from '@/modules/kernel/infrastructure/db/client';
import { unwrapParseResult } from '@/modules/kernel/testing';
import {
  createUserUseCases,
  type UserTransactionContext,
} from '@/modules/user';
import type { TelemetryAdapter } from '@/platform/telemetry';

const now = new Date('2026-01-01T00:00:00.000Z');
const adminId = unwrapParseResult(toUserId('admin-1'));
const userId = unwrapParseResult(toUserId('user-1'));
const currentSessionId = unwrapParseResult(toSessionId('admin-session'));
const targetSessionId = unwrapParseResult(toSessionId('session-1'));
const correlationId = unwrapParseResult(toCorrelationId('request-1'));
const logger = {
  debug() {},
  error() {},
  info() {},
  warn() {},
};

const getOk = <TOutcome extends { type: string }>(
  result: ApplicationResult<TOutcome>
) => {
  if (result.isError()) throw result.getError();
  return result.get();
};

const createAudit = (db: DbLike, eventId: string) => {
  let sequence = 0;
  return createAuditPort({
    clock: { now: () => now },
    failureSignal: createLoggerAuditFailureSignal(logger),
    idGenerator: {
      createId: () => {
        sequence += 1;
        return toGeneratedId(
          sequence === 1 ? eventId : `${eventId}-${sequence}`
        );
      },
    },
    repository: createAuditRepository({ db }),
  });
};

const makeCachedAuth = (input: { sessionId: string; userId: string }) =>
  ({
    api: {
      getSession: async () => ({
        user: {
          id: input.userId,
          email: 'user@example.com',
          name: 'Cached User',
          image: null,
          emailVerified: true,
          role: 'admin',
          onboardedAt: null,
        },
        session: {
          id: input.sessionId,
          userId: input.userId,
          createdAt: now,
          expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        },
      }),
    },
  }) as unknown as Auth;

const telemetry = {
  startSpan: (_options: unknown, work: () => unknown) => work(),
} as unknown as Pick<TelemetryAdapter, 'startSpan'>;

describe('user session revocation audit transaction', () => {
  let database: Awaited<ReturnType<typeof createPgliteTestDatabase>>;

  beforeAll(async () => {
    database = await createPgliteTestDatabase();
  });

  beforeEach(async () => {
    await database.truncate();
    await database.db.insert(userTable).values([
      makeUserRow({
        id: adminId,
        email: 'admin@example.com',
        role: 'admin',
      }),
      makeUserRow({ id: userId, email: 'user@example.com', role: 'user' }),
    ]);
    await database.db
      .insert(sessionTable)
      .values([
        makeSessionRow({ id: 'session-1', token: 'token-1', userId }),
        makeSessionRow({ id: 'session-2', token: 'token-2', userId }),
      ]);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await database?.close();
  });

  const createUseCases = (
    eventId: string,
    auditFactory?: (transaction: DbLike) => AuditPort
  ) =>
    createUserUseCases({
      userRepository: createUserRepository({ db: database.db }),
      userAuthGateway: {
        removeUser: async () => Result.Ok({ type: 'user_auth_removed' }),
      },
      transactionRunner: createResultTransactionRunner({
        transactionRunner: createTransactionRunner(database.db),
        bindContext: (transaction): UserTransactionContext => ({
          audit:
            auditFactory?.(transaction) ?? createAudit(transaction, eventId),
          securityRepository: createUserSecurityRepository({ db: transaction }),
          userRepository: createUserRepository({ db: transaction }),
        }),
      }),
      permissionChecker: {
        hasPermission: async () =>
          Result.Ok({ type: 'permission_granted' as const }),
      },
      logger,
    });

  const seedReverseIdentityAlias = async () => {
    const aliasUserId = unwrapParseResult(toUserId('provider-alias'));
    const aliasSessionId = unwrapParseResult(toSessionId('alias-session'));
    await database.db.insert(userTable).values(
      makeUserRow({
        id: aliasUserId,
        email: 'provider-alias@example.com',
      })
    );
    await database.db.insert(sessionTable).values(
      makeSessionRow({
        id: aliasSessionId,
        token: 'alias-token',
        userId: aliasUserId,
      })
    );
    await database.db.insert(authIdentity).values({
      provider: 'better-auth',
      providerUserId: aliasUserId,
      userId,
    });

    return { aliasSessionId, aliasUserId };
  };

  const expectReverseAliasRejected = async (result: unknown) => {
    expect(result).toMatchObject({
      tag: 'Error',
      error: { code: 'AUTH_IDENTITY_DESTRUCTIVE_MAPPING_UNSUPPORTED' },
    });
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      3
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  };

  it('commits revoke-all and its required audit event together', async () => {
    const outcome = getOk(
      await createUseCases('audit-revoke-all').revokeSessions({
        correlationId,
        currentUserId: adminId,
        id: userId,
      })
    );

    expect(outcome.type).toBe('user_sessions_revoked');
    await expect(database.db.select().from(sessionTable)).resolves.toEqual([]);
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual([
      expect.objectContaining({
        id: 'audit-revoke-all',
        type: 'session.revoked',
        actorId: adminId,
        subjectId: userId,
        subjectKind: 'user',
        correlationId,
        metadata: { reason: 'administrator', scope: 'all' },
      }),
    ]);
  });

  it('commits one-session revocation without deleting sibling sessions', async () => {
    const outcome = getOk(
      await createUseCases('audit-revoke-one').revokeSession({
        correlationId,
        currentUserId: adminId,
        currentSessionId,
        id: userId,
        sessionId: targetSessionId,
      })
    );

    expect(outcome.type).toBe('user_session_revoked');
    await expect(database.db.select().from(sessionTable)).resolves.toEqual([
      expect.objectContaining({ id: 'session-2' }),
    ]);
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual([
      expect.objectContaining({
        id: 'audit-revoke-one',
        type: 'session.revoked',
        actorId: adminId,
        subjectId: targetSessionId,
        subjectKind: 'session',
        correlationId,
        metadata: { reason: 'administrator', scope: 'single' },
      }),
    ]);
  });

  it('rolls session deletion back when required audit persistence fails', async () => {
    const auditError = new AppError({
      code: 'AUDIT_EVENT_PERSISTENCE_FAILED',
      category: 'system',
      status: 500,
    });
    const result = await createUseCases('unused', () => ({
      record: async () => Result.Error(auditError),
    })).revokeSessions({
      correlationId,
      currentUserId: adminId,
      id: userId,
    });

    expect(result.isError()).toBe(true);
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      2
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('rolls a single-session deletion back when required audit persistence fails', async () => {
    const auditError = new AppError({
      code: 'AUDIT_EVENT_PERSISTENCE_FAILED',
      category: 'system',
      status: 500,
    });
    const result = await createUseCases('unused', () => ({
      record: async () => Result.Error(auditError),
    })).revokeSession({
      correlationId,
      currentUserId: adminId,
      currentSessionId,
      id: userId,
      sessionId: targetSessionId,
    });

    expect(result.isError()).toBe(true);
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      2
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('reports a real zero-row revoke-all as unchanged without an audit', async () => {
    await database.db.delete(sessionTable);

    const outcome = getOk(
      await createUseCases('unused').revokeSessions({
        correlationId,
        currentUserId: adminId,
        id: userId,
      })
    );

    expect(outcome).toEqual({ type: 'user_sessions_unchanged' });
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('reports a real missing single session without deleting siblings or auditing', async () => {
    const outcome = getOk(
      await createUseCases('unused').revokeSession({
        correlationId,
        currentUserId: adminId,
        currentSessionId,
        id: userId,
        sessionId: unwrapParseResult(toSessionId('missing-session')),
      })
    );

    expect(outcome).toEqual({ type: 'user_session_not_found' });
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      2
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('rejects both revocation paths when durable authorization was demoted', async () => {
    await database.db
      .update(userTable)
      .set({ role: 'user' })
      .where(eq(userTable.id, adminId));
    const useCases = createUseCases('unused');

    const revokeAll = getOk(
      await useCases.revokeSessions({
        correlationId,
        currentUserId: adminId,
        id: userId,
      })
    );
    const revokeOne = getOk(
      await useCases.revokeSession({
        correlationId,
        currentUserId: adminId,
        currentSessionId,
        id: userId,
        sessionId: targetSessionId,
      })
    );

    expect(revokeAll).toEqual({ type: 'user_forbidden' });
    expect(revokeOne).toEqual({ type: 'user_forbidden' });
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      2
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('commits a role change, session invalidation, and both required audits together', async () => {
    const outcome = getOk(
      await createUseCases('audit-role-change').update({
        correlationId,
        currentUserId: adminId,
        id: userId,
        user: {
          email: unwrapParseResult(toEmailAddress('user@example.com')),
          role: 'admin',
        },
      })
    );

    expect(outcome).toMatchObject({
      type: 'user_updated',
      user: { id: userId, role: 'admin' },
    });
    await expect(database.db.select().from(sessionTable)).resolves.toEqual([]);
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'audit-role-change',
          type: 'authorization.role-changed',
          actorId: adminId,
          subjectId: userId,
          correlationId,
          metadata: { from: 'user', to: 'admin' },
        }),
        expect.objectContaining({
          id: 'audit-role-change-2',
          type: 'session.revoked',
          actorId: adminId,
          subjectId: userId,
          correlationId,
          metadata: { reason: 'role-change', scope: 'all' },
        }),
      ])
    );
  });

  it('records only the role audit when a role change has no sessions to invalidate', async () => {
    await database.db.delete(sessionTable);

    const outcome = getOk(
      await createUseCases('audit-role-only').update({
        correlationId,
        currentUserId: adminId,
        id: userId,
        user: {
          email: unwrapParseResult(toEmailAddress('user@example.com')),
          role: 'admin',
        },
      })
    );

    expect(outcome).toMatchObject({
      type: 'user_updated',
      user: { role: 'admin' },
    });
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual([
      expect.objectContaining({
        id: 'audit-role-only',
        type: 'authorization.role-changed',
        metadata: { from: 'user', to: 'admin' },
      }),
    ]);
  });

  it('rejects a role change when the durable actor was demoted', async () => {
    await database.db
      .update(userTable)
      .set({ role: 'user' })
      .where(eq(userTable.id, adminId));

    const outcome = getOk(
      await createUseCases('unused').update({
        correlationId,
        currentUserId: adminId,
        id: userId,
        user: {
          email: unwrapParseResult(toEmailAddress('user@example.com')),
          role: 'admin',
        },
      })
    );

    expect(outcome).toEqual({ type: 'user_forbidden' });
    await expect(
      database.db
        .select({ role: userTable.role })
        .from(userTable)
        .where(eq(userTable.id, userId))
    ).resolves.toEqual([{ role: 'user' }]);
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      2
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('rolls a role write back when identity ownership is divergent', async () => {
    await database.db.insert(authIdentity).values({
      provider: 'better-auth',
      providerUserId: 'different-provider-user',
      userId,
    });

    const result = await createUseCases('unused').update({
      correlationId,
      currentUserId: adminId,
      id: userId,
      user: {
        email: unwrapParseResult(toEmailAddress('user@example.com')),
        role: 'admin',
      },
    });

    expect(result).toMatchObject({
      tag: 'Error',
      error: { code: 'AUTH_IDENTITY_DESTRUCTIVE_MAPPING_UNSUPPORTED' },
    });
    await expect(
      database.db
        .select({ role: userTable.role })
        .from(userTable)
        .where(eq(userTable.id, userId))
    ).resolves.toEqual([{ role: 'user' }]);
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      2
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('maps corrupt durable target data to a bounded persistence failure', async () => {
    await database.db
      .update(userTable)
      .set({ email: 'not-an-email-address' })
      .where(eq(userTable.id, userId));

    const result = await createUserSecurityRepository({
      db: database.db,
    }).lockUserForUpdate(userId);

    expect(result).toMatchObject({
      tag: 'Error',
      error: {
        category: 'system',
        code: 'USER_SECURITY_PERSISTENCE_FAILED',
        status: 500,
      },
    });
  });

  it('rolls role, sessions, and the first audit back when the second audit fails', async () => {
    const auditError = new AppError({
      code: 'AUDIT_EVENT_PERSISTENCE_FAILED',
      category: 'system',
      status: 500,
    });
    const result = await createUseCases(
      'audit-role-rollback',
      (transaction) => {
        const durableAudit = createAudit(transaction, 'audit-role-rollback');
        return {
          record: vi
            .fn<AuditPort['record']>()
            .mockImplementationOnce((event) => durableAudit.record(event))
            .mockImplementationOnce(async () => Result.Error(auditError)),
        };
      }
    ).update({
      correlationId,
      currentUserId: adminId,
      id: userId,
      user: {
        email: unwrapParseResult(toEmailAddress('user@example.com')),
        role: 'admin',
      },
    });

    expect(result.isError()).toBe(true);
    await expect(
      database.db
        .select({ role: userTable.role })
        .from(userTable)
        .where(eq(userTable.id, userId))
    ).resolves.toEqual([{ role: 'user' }]);
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      2
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('fails closed for a divergent provider identity mapping', async () => {
    await database.db.insert(authIdentity).values({
      provider: 'better-auth',
      providerUserId: 'different-provider-user',
      userId,
    });

    const result = await createUseCases('unused').revokeSessions({
      correlationId,
      currentUserId: adminId,
      id: userId,
    });

    expect(result).toMatchObject({
      tag: 'Error',
      error: { code: 'AUTH_IDENTITY_DESTRUCTIVE_MAPPING_UNSUPPORTED' },
    });
    await expect(database.db.select().from(sessionTable)).resolves.toHaveLength(
      2
    );
    await expect(database.db.select().from(auditEventTable)).resolves.toEqual(
      []
    );
  });

  it('fails closed when revoke-all targets the reverse side of an identity alias', async () => {
    const { aliasUserId } = await seedReverseIdentityAlias();
    const result = await createUseCases('unused').revokeSessions({
      correlationId,
      currentUserId: adminId,
      id: aliasUserId,
    });

    expect(result.isError()).toBe(true);
    await expectReverseAliasRejected(result);
  });

  it('fails closed when revoke-one targets the reverse side of an identity alias', async () => {
    const { aliasSessionId, aliasUserId } = await seedReverseIdentityAlias();
    const result = await createUseCases('unused').revokeSession({
      correlationId,
      currentUserId: adminId,
      currentSessionId,
      id: aliasUserId,
      sessionId: aliasSessionId,
    });

    expect(result.isError()).toBe(true);
    await expectReverseAliasRejected(result);
  });

  it('rejects a stale Better Auth cache hit after durable revocation commits', async () => {
    vi.stubEnv(
      'AUTH_SECRET',
      'integration-only-auth-secret-with-32-characters'
    );
    const gateway = new SessionGatewayBetterAuth(
      makeCachedAuth({ sessionId: targetSessionId, userId }),
      database.db as Database,
      { now: () => now },
      telemetry
    );

    expect(
      getOk(await gateway.getSession({ headers: new Headers() })).type
    ).toBe('auth_session_found');
    getOk(
      await createUseCases('audit-cache-boundary').revokeSession({
        correlationId,
        currentUserId: adminId,
        currentSessionId,
        id: userId,
        sessionId: targetSessionId,
      })
    );

    expect(getOk(await gateway.getSession({ headers: new Headers() }))).toEqual(
      {
        type: 'auth_session_missing',
      }
    );
  });
});
