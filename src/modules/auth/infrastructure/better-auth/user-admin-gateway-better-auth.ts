import { Result } from '@bloodyowl/boxed';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import type { TelemetryAdapter } from '@/platform/telemetry';

import type { Auth } from './auth';
import { getDefaultAuth } from './auth';
import type { UserAdminGateway } from '../../application/ports/user-admin-gateway';

export class UserAdminGatewayBetterAuth implements UserAdminGateway {
  constructor(
    private readonly telemetry: Pick<TelemetryAdapter, 'startSpan'>,
    private readonly auth: Auth = getDefaultAuth()
  ) {}

  async removeUser(
    input: Parameters<UserAdminGateway['removeUser']>[0]
  ): ReturnType<UserAdminGateway['removeUser']> {
    return this.telemetry.startSpan(
      {
        attributes: {
          'auth.provider': 'better-auth',
          'operation.name': 'auth.removeUser',
          'operation.type': 'provider_operation',
        },
        name: 'auth.removeUser',
        op: 'auth.provider',
      },
      async () => {
        try {
          const response = await this.auth.api.removeUser({
            body: { userId: input.userId },
            headers: input.headers,
          });
          if (!response.success) {
            return Result.Error(
              new AppError({
                code: 'AUTH_USER_REMOVE_FAILED',
                category: 'system',
                status: 500,
                message: 'Failed to remove auth user',
              })
            );
          }
          return Result.Ok({ type: 'auth_user_removed' });
        } catch (error) {
          return Result.Error(
            new AppError({
              code: 'AUTH_USER_REMOVE_FAILED',
              category: 'system',
              status: 500,
              message: 'Failed to remove auth user',
              cause: error,
            })
          );
        }
      }
    );
  }

  async revokeUserSessions(
    input: Parameters<UserAdminGateway['revokeUserSessions']>[0]
  ): ReturnType<UserAdminGateway['revokeUserSessions']> {
    return this.telemetry.startSpan(
      {
        attributes: {
          'auth.provider': 'better-auth',
          'operation.name': 'auth.revokeUserSessions',
          'operation.type': 'provider_operation',
        },
        name: 'auth.revokeUserSessions',
        op: 'auth.provider',
      },
      async () => {
        try {
          const response = await this.auth.api.revokeUserSessions({
            body: { userId: input.userId },
            headers: input.headers,
          });
          if (!response.success) {
            return Result.Error(
              new AppError({
                code: 'AUTH_USER_SESSIONS_REVOKE_FAILED',
                category: 'system',
                status: 500,
                message: 'Failed to revoke auth user sessions',
              })
            );
          }
          return Result.Ok({ type: 'auth_user_sessions_revoked' });
        } catch (error) {
          return Result.Error(
            new AppError({
              code: 'AUTH_USER_SESSIONS_REVOKE_FAILED',
              category: 'system',
              status: 500,
              message: 'Failed to revoke auth user sessions',
              cause: error,
            })
          );
        }
      }
    );
  }
}
