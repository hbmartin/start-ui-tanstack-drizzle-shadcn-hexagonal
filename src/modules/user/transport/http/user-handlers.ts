import { z } from 'zod';

import type { ProtectedContext } from '@/modules/auth/backend';
import {
  zEmailAddress,
  zSessionId,
  zUserId,
} from '@/modules/kernel/domain/ids';
import {
  type OutcomeHandlerConfig,
  unwrapApplicationResult,
} from '@/modules/kernel/transport/tanstack/result-mapper';
import type { UserUseCases } from '@/modules/user';

import type {
  UserCreateOutcome,
  UserDeleteOutcome,
  UserGetOutcome,
  UserListOutcome,
  UserRevokeSessionOutcome,
  UserRevokeSessionsOutcome,
  UserSessionsListOutcome,
  UserUpdateOutcome,
} from '../../application/use-cases/types';
import type {
  User,
  UserListPage,
  UserSessionListPage,
} from '../../domain/user';
import { zUserDisplayName } from '../../domain/user';

const zRole = () => z.enum(['admin', 'user']);

export const zGetAllInput = () =>
  z
    .object({
      cursor: zUserId().optional(),
      limit: z.coerce.number().int().min(1).max(100).prefault(20),
      searchTerm: z.string().trim().optional(),
    })
    .prefault({});

export const zGetByIdInput = () => z.object({ id: zUserId() });

export const zUpdateByIdInput = () =>
  z.object({
    id: zUserId(),
    name: zUserDisplayName().nullish(),
    email: zEmailAddress(),
    role: zRole().nullish(),
  });

export const zCreateInput = () =>
  z.object({
    name: zUserDisplayName().nullish(),
    email: zEmailAddress(),
    role: zRole().nullish(),
  });

export const zDeleteByIdInput = () => z.object({ id: zUserId() });

export const zGetUserSessionsInput = () =>
  z.object({
    userId: zUserId(),
    cursor: zSessionId().optional(),
    limit: z.coerce.number().int().min(1).max(100).prefault(20),
  });

export const zRevokeUserSessionsInput = () => z.object({ id: zUserId() });

export const zRevokeUserSessionInput = () =>
  z.object({ id: zUserId(), sessionId: zSessionId() });

type UserHandlerDeps = {
  getUseCases: (ctx: ProtectedContext) => UserUseCases;
};

const userDuplicateConfig = {
  user_duplicate: {
    code: 'CONFLICT',
    reason: 'already_exists',
    target: 'user.email',
  },
} as const;

const userSelfConfig = () =>
  ({
    user_self: {
      code: 'BAD_REQUEST',
      reason: 'self_action_forbidden',
      target: 'user',
    },
  }) as const;

const userListConfig = {
  user_forbidden: 'FORBIDDEN',
  user_listed: (outcome) => outcome.page,
} as const satisfies OutcomeHandlerConfig<UserListOutcome, UserListPage>;

const userGetConfig = {
  user_forbidden: 'FORBIDDEN',
  user_found: (outcome) => outcome.user,
  user_not_found: {
    code: 'NOT_FOUND',
    reason: 'not_found',
    target: 'user',
  },
} as const satisfies OutcomeHandlerConfig<UserGetOutcome, User>;

const userCreateConfig = {
  user_created: (outcome) => outcome.user,
  user_forbidden: 'FORBIDDEN',
  ...userDuplicateConfig,
} as const satisfies OutcomeHandlerConfig<UserCreateOutcome, User>;

const userUpdateConfig = {
  user_forbidden: 'FORBIDDEN',
  user_not_found: {
    code: 'NOT_FOUND',
    reason: 'not_found',
    target: 'user',
  },
  user_updated: (outcome) => outcome.user,
  ...userDuplicateConfig,
} as const satisfies OutcomeHandlerConfig<UserUpdateOutcome, User>;

const userDeleteConfig = () =>
  ({
    user_deleted: () => undefined,
    user_forbidden: 'FORBIDDEN',
    user_not_found: {
      code: 'NOT_FOUND',
      reason: 'not_found',
      target: 'user',
    },
    ...userSelfConfig(),
  }) as const satisfies OutcomeHandlerConfig<UserDeleteOutcome, void>;

const userSessionsListConfig = {
  user_forbidden: 'FORBIDDEN',
  user_sessions_listed: (outcome) => outcome.page,
} as const satisfies OutcomeHandlerConfig<
  UserSessionsListOutcome,
  UserSessionListPage
>;

const userRevokeSessionsConfig = () =>
  ({
    user_forbidden: 'FORBIDDEN',
    user_sessions_revoked: () => undefined,
    user_sessions_unchanged: () => undefined,
    ...userSelfConfig(),
  }) as const satisfies OutcomeHandlerConfig<UserRevokeSessionsOutcome, void>;

const userRevokeSessionConfig = () =>
  ({
    user_forbidden: 'FORBIDDEN',
    user_session_not_found: {
      code: 'NOT_FOUND',
      reason: 'not_found',
      target: 'user.session',
    },
    user_session_revoked: () => undefined,
    ...userSelfConfig(),
  }) as const satisfies OutcomeHandlerConfig<UserRevokeSessionOutcome, void>;

export const createUserHandlers = ({ getUseCases }: UserHandlerDeps) => {
  const getAll = async (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zGetAllInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).list({
        currentUserId: ctx.scope.userId,
        cursor: data.cursor,
        limit: data.limit,
        searchTerm: data.searchTerm ?? '',
      }),
      userListConfig
    );
  };

  const getById = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zGetByIdInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).get({
        currentUserId: ctx.scope.userId,
        id: data.id,
      }),
      userGetConfig
    );
  };

  const updateById = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zUpdateByIdInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).update({
        correlationId: ctx.correlationId,
        currentUserId: ctx.scope.userId,
        id: data.id,
        user: {
          name: data.name,
          email: data.email,
          role: data.role,
        },
      }),
      userUpdateConfig
    );
  };

  const create = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zCreateInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).create({
        currentUserId: ctx.scope.userId,
        user: {
          name: data.name,
          email: data.email,
          role: data.role,
        },
      }),
      userCreateConfig
    );
  };

  const deleteById = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zDeleteByIdInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).delete({
        correlationId: ctx.correlationId,
        currentUserId: ctx.scope.userId,
        id: data.id,
      }),
      userDeleteConfig()
    );
  };

  const getUserSessions = async (
    ctx: ProtectedContext,
    data: z.output<ReturnType<typeof zGetUserSessionsInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).listSessions({
        currentUserId: ctx.scope.userId,
        userId: data.userId,
        cursor: data.cursor,
        limit: data.limit,
      }),
      userSessionsListConfig
    );
  };

  const revokeUserSessions = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zRevokeUserSessionsInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).revokeSessions({
        correlationId: ctx.correlationId,
        currentUserId: ctx.scope.userId,
        id: data.id,
      }),
      userRevokeSessionsConfig()
    );
  };

  const revokeUserSession = async (
    ctx: ProtectedContext,
    data: z.infer<ReturnType<typeof zRevokeUserSessionInput>>
  ) => {
    return unwrapApplicationResult(
      getUseCases(ctx).revokeSession({
        correlationId: ctx.correlationId,
        currentUserId: ctx.scope.userId,
        currentSessionId: ctx.session.id,
        id: data.id,
        sessionId: data.sessionId,
      }),
      userRevokeSessionConfig()
    );
  };

  return {
    getAll,
    getById,
    updateById,
    create,
    deleteById,
    getUserSessions,
    revokeUserSessions,
    revokeUserSession,
  };
};

export type UserHandlers = ReturnType<typeof createUserHandlers>;
