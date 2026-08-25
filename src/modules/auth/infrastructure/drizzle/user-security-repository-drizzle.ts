import { Result } from '@bloodyowl/boxed';
import { and, asc, eq, inArray, or } from 'drizzle-orm';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { ApplicationResult } from '@/modules/kernel/application/result';
import type { SessionId, UserId } from '@/modules/kernel/domain/ids';
import type { DbLike } from '@/modules/kernel/infrastructure/db/types';

import {
  authIdentity,
  session as sessionTable,
  user as userTable,
} from './schema';

const persistenceError = (operation: string, cause: unknown) =>
  new AppError({
    code: 'USER_SECURITY_PERSISTENCE_FAILED',
    category: 'system',
    status: 500,
    message: `User security persistence failed during ${operation}`,
    cause,
  });

const unsupportedIdentityMapping = (userId: UserId, providerUserId: string) =>
  new AppError({
    code: 'AUTH_IDENTITY_DESTRUCTIVE_MAPPING_UNSUPPORTED',
    category: 'system',
    status: 500,
    message: 'Destructive auth operation requires a local identity mapping',
    details: { provider: 'better-auth', providerUserId, userId },
  });

class UserSecurityRepositoryDrizzle {
  constructor(private readonly db: DbLike) {}

  private async resolveLocalProviderUserId(
    userId: UserId
  ): Promise<ApplicationResult<string>> {
    const identities = await this.db
      .select({
        providerUserId: authIdentity.providerUserId,
        userId: authIdentity.userId,
      })
      .from(authIdentity)
      .where(
        and(
          eq(authIdentity.provider, 'better-auth'),
          or(
            eq(authIdentity.userId, userId),
            eq(authIdentity.providerUserId, userId)
          )
        )
      )
      .for('update');
    const divergentIdentity = identities.find(
      (identity) => identity.providerUserId !== identity.userId
    );

    // The v5 auth schema still stores app principals and provider users in the
    // same table. A divergent mapping could target another principal's FK
    // rows through either side of the alias, so destructive operations fail
    // closed until those stores split.
    if (divergentIdentity) {
      return Result.Error(
        unsupportedIdentityMapping(userId, divergentIdentity.providerUserId)
      );
    }
    return Result.Ok(userId);
  }

  async lockAuthorizationPrincipal(userId: UserId): Promise<
    ApplicationResult<
      | Readonly<{
          role: 'admin' | 'user';
          type: 'user_security_principal_found';
        }>
      | Readonly<{ type: 'user_security_principal_not_found' }>
    >
  > {
    try {
      const [principal] = await this.db
        .select({ role: userTable.role })
        .from(userTable)
        .where(eq(userTable.id, userId))
        .for('update');

      return Result.Ok(
        principal
          ? { type: 'user_security_principal_found', role: principal.role }
          : { type: 'user_security_principal_not_found' }
      );
    } catch (error) {
      return Result.Error(persistenceError('authorization lock', error));
    }
  }

  async lockMutationPrincipals(input: {
    actorId: UserId;
    targetId: UserId;
  }): Promise<
    ApplicationResult<
      Readonly<{
        actor:
          | Readonly<{
              role: 'admin' | 'user';
              type: 'user_security_principal_found';
            }>
          | Readonly<{ type: 'user_security_principal_not_found' }>;
        target:
          | Readonly<{
              role: 'admin' | 'user';
              type: 'user_security_principal_found';
            }>
          | Readonly<{ type: 'user_security_principal_not_found' }>;
        type: 'user_security_mutation_principals_locked';
      }>
    >
  > {
    try {
      const principals = await this.db
        .select({ id: userTable.id, role: userTable.role })
        .from(userTable)
        .where(inArray(userTable.id, [input.actorId, input.targetId]))
        .orderBy(asc(userTable.id))
        .for('update');
      const actor = principals.find(
        (principal) => principal.id === input.actorId
      );
      const target = principals.find(
        (principal) => principal.id === input.targetId
      );

      return Result.Ok({
        type: 'user_security_mutation_principals_locked',
        actor: actor
          ? { type: 'user_security_principal_found', role: actor.role }
          : { type: 'user_security_principal_not_found' },
        target: target
          ? { type: 'user_security_principal_found', role: target.role }
          : { type: 'user_security_principal_not_found' },
      });
    } catch (error) {
      return Result.Error(persistenceError('mutation principal locks', error));
    }
  }

  async deleteUser(
    userId: UserId
  ): Promise<
    ApplicationResult<
      Readonly<{ type: 'user_deleted' }> | Readonly<{ type: 'user_not_found' }>
    >
  > {
    try {
      const providerUserId = await this.resolveLocalProviderUserId(userId);
      if (providerUserId.isError()) {
        return Result.Error(providerUserId.getError());
      }
      const [deleted] = await this.db
        .delete(userTable)
        .where(eq(userTable.id, providerUserId.get()))
        .returning({ id: userTable.id });

      return Result.Ok({ type: deleted ? 'user_deleted' : 'user_not_found' });
    } catch (error) {
      return Result.Error(persistenceError('user deletion', error));
    }
  }

  async revokeSessions(
    userId: UserId
  ): Promise<
    ApplicationResult<
      Readonly<{ count: number; type: 'user_sessions_revoked' }>
    >
  > {
    try {
      const providerUserId = await this.resolveLocalProviderUserId(userId);
      if (providerUserId.isError()) {
        return Result.Error(providerUserId.getError());
      }
      const deleted = await this.db
        .delete(sessionTable)
        .where(eq(sessionTable.userId, providerUserId.get()))
        .returning({ id: sessionTable.id });

      return Result.Ok({
        type: 'user_sessions_revoked',
        count: deleted.length,
      });
    } catch (error) {
      return Result.Error(persistenceError('session revocation', error));
    }
  }

  async revokeSession(input: {
    sessionId: SessionId;
    userId: UserId;
  }): Promise<
    ApplicationResult<
      | Readonly<{ type: 'user_session_not_found' }>
      | Readonly<{ type: 'user_session_revoked' }>
    >
  > {
    try {
      const providerUserId = await this.resolveLocalProviderUserId(
        input.userId
      );
      if (providerUserId.isError()) {
        return Result.Error(providerUserId.getError());
      }
      const [deleted] = await this.db
        .delete(sessionTable)
        .where(
          and(
            eq(sessionTable.id, input.sessionId),
            eq(sessionTable.userId, providerUserId.get())
          )
        )
        .returning({ id: sessionTable.id });

      return Result.Ok(
        deleted
          ? { type: 'user_session_revoked' }
          : { type: 'user_session_not_found' }
      );
    } catch (error) {
      return Result.Error(persistenceError('single-session revocation', error));
    }
  }
}

export const createUserSecurityRepository = (input: { db: DbLike }) =>
  new UserSecurityRepositoryDrizzle(input.db);
