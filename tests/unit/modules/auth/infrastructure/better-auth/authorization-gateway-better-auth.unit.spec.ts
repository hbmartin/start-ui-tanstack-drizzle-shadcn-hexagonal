import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthorizationGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/authorization-gateway-better-auth';
import type { Database } from '@/modules/kernel/infrastructure/db/client';
import { toUserId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import type { TelemetryAdapter } from '@/platform/telemetry';

const startSpan = vi.fn((_options: unknown, fn: () => unknown) => fn());
const telemetry = { startSpan } as unknown as Pick<
  TelemetryAdapter,
  'startSpan'
>;

const makeDb = (findFirst: ReturnType<typeof vi.fn>) =>
  ({
    query: { user: { findFirst } },
  }) as unknown as Database;

const makeInput = () => ({
  userId: unwrapParseResult(toUserId('user-1')),
  permissions: { book: ['delete'] },
  headers: new Headers(),
});

describe('AuthorizationGatewayBetterAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('grants permissions from the durable app-user role', async () => {
    const findFirst = vi.fn(async () => ({ role: 'admin' }));
    const gateway = new AuthorizationGatewayBetterAuth(
      makeDb(findFirst),
      telemetry
    );

    const result = await gateway.userHasPermission(makeInput());

    expect(result).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_permission_granted' },
    });
    expect(findFirst).toHaveBeenCalledOnce();
    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'auth.provider': 'better-auth',
          'operation.name': 'auth.userHasPermission',
        }),
        name: 'auth.userHasPermission',
        op: 'auth.provider',
      }),
      expect.any(Function)
    );
  });

  it.each([
    { name: 'least-privileged role', row: { role: 'user' } },
    { name: 'missing principal', row: null },
    { name: 'invalid durable role', row: { role: 'owner' } },
  ])('denies permissions for a $name', async ({ row }) => {
    const gateway = new AuthorizationGatewayBetterAuth(
      makeDb(vi.fn(async () => row)),
      telemetry
    );

    const result = await gateway.userHasPermission(makeInput());

    expect(result).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_permission_denied' },
    });
  });

  it('maps durable-role lookup failures to AppError results', async () => {
    const databaseError = new Error('permission database failed');
    const gateway = new AuthorizationGatewayBetterAuth(
      makeDb(
        vi.fn(async () => {
          throw databaseError;
        })
      ),
      telemetry
    );

    const result = await gateway.userHasPermission(makeInput());

    expect(result).toMatchObject({
      tag: 'Error',
      error: {
        category: 'system',
        code: 'AUTH_PERMISSION_CHECK_FAILED',
        status: 500,
      },
    });
    expect(result).toHaveProperty('error.cause', databaseError);
  });
});
