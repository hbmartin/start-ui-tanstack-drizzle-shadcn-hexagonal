import { Result } from '@bloodyowl/boxed';
import { eq } from 'drizzle-orm';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  type Database,
  getDefaultDbClient,
} from '@/modules/kernel/infrastructure/db/client';
import type { TelemetryAdapter } from '@/platform/telemetry';

import { user as userTable } from '../drizzle/schema';
import type { AuthorizationGateway } from '../../application/ports/authorization-gateway';
import {
  hasRolePermission,
  parseRole,
  type Permission,
} from '../../domain/permissions';

export class AuthorizationGatewayBetterAuth implements AuthorizationGateway {
  constructor(
    private readonly db: Database = getDefaultDbClient(),
    private readonly telemetry: Pick<TelemetryAdapter, 'startSpan'>
  ) {}

  async userHasPermission(
    input: Parameters<AuthorizationGateway['userHasPermission']>[0]
  ): ReturnType<AuthorizationGateway['userHasPermission']> {
    return this.telemetry.startSpan(
      {
        attributes: {
          'auth.provider': 'better-auth',
          'operation.name': 'auth.userHasPermission',
          'operation.type': 'provider_operation',
        },
        name: 'auth.userHasPermission',
        op: 'auth.provider',
      },
      async () => {
        try {
          // Better Auth prefers its secondary-storage user snapshot when a
          // session is cached. Authorization must instead use the durable app
          // principal so committed role changes take effect immediately.
          const user = await this.db.query.user.findFirst({
            where: eq(userTable.id, input.userId),
            columns: { role: true },
          });
          const role = parseRole(user?.role);
          return Result.Ok(
            role && hasRolePermission(role, input.permissions as Permission)
              ? { type: 'auth_permission_granted' }
              : { type: 'auth_permission_denied' }
          );
        } catch (error) {
          return Result.Error(
            new AppError({
              code: 'AUTH_PERMISSION_CHECK_FAILED',
              category: 'system',
              status: 500,
              message: 'Failed to check user permission',
              cause: error,
            })
          );
        }
      }
    );
  }
}
