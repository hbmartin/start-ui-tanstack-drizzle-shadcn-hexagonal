import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Auth } from '@/modules/auth/infrastructure/better-auth/auth';
import { UserAdminGatewayBetterAuth } from '@/modules/auth/infrastructure/better-auth/user-admin-gateway-better-auth';
import { toUserId } from '@/modules/kernel/domain/ids';
import { unwrapParseResult } from '@/modules/kernel/testing';
import type { TelemetryAdapter } from '@/platform/telemetry';

const startSpan = vi.fn((_options: unknown, work: () => unknown) => work());
const telemetry = { startSpan } as unknown as Pick<
  TelemetryAdapter,
  'startSpan'
>;

const makeAuth = (input?: {
  removeSuccess?: boolean;
  revokeSuccess?: boolean;
}) => ({
  api: {
    removeUser: vi.fn(async () => ({ success: input?.removeSuccess ?? true })),
    revokeUserSessions: vi.fn(async () => ({
      success: input?.revokeSuccess ?? true,
    })),
  },
});

describe('UserAdminGatewayBetterAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('removes a provider user through the bounded adapter', async () => {
    const auth = makeAuth();
    const gateway = new UserAdminGatewayBetterAuth(
      telemetry,
      auth as unknown as Auth
    );
    const headers = new Headers();
    const userId = unwrapParseResult(toUserId('user-1'));

    const result = await gateway.removeUser({ userId, headers });

    expect(result).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_user_removed' },
    });
    expect(auth.api.removeUser).toHaveBeenCalledWith({
      body: { userId },
      headers,
    });
    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'operation.name': 'auth.removeUser',
        }),
        name: 'auth.removeUser',
      }),
      expect.any(Function)
    );
  });

  it('revokes all provider sessions through the bounded adapter', async () => {
    const auth = makeAuth();
    const gateway = new UserAdminGatewayBetterAuth(
      telemetry,
      auth as unknown as Auth
    );
    const headers = new Headers();
    const userId = unwrapParseResult(toUserId('user-1'));

    const result = await gateway.revokeUserSessions({ userId, headers });

    expect(result).toMatchObject({
      tag: 'Ok',
      value: { type: 'auth_user_sessions_revoked' },
    });
    expect(auth.api.revokeUserSessions).toHaveBeenCalledWith({
      body: { userId },
      headers,
    });
    expect(startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'operation.name': 'auth.revokeUserSessions',
        }),
        name: 'auth.revokeUserSessions',
      }),
      expect.any(Function)
    );
  });

  it('maps an unsuccessful remove response to an application error', async () => {
    const auth = makeAuth({ removeSuccess: false, revokeSuccess: false });
    const gateway = new UserAdminGatewayBetterAuth(
      telemetry,
      auth as unknown as Auth
    );
    const result = await gateway.removeUser({
      userId: unwrapParseResult(toUserId('user-1')),
      headers: new Headers(),
    });

    expect(result).toMatchObject({
      tag: 'Error',
      error: { code: 'AUTH_USER_REMOVE_FAILED' },
    });
  });

  it('maps an unsuccessful revoke-all response to an application error', async () => {
    const auth = makeAuth({ removeSuccess: false, revokeSuccess: false });
    const gateway = new UserAdminGatewayBetterAuth(
      telemetry,
      auth as unknown as Auth
    );
    const result = await gateway.revokeUserSessions({
      userId: unwrapParseResult(toUserId('user-1')),
      headers: new Headers(),
    });

    expect(result).toMatchObject({
      tag: 'Error',
      error: { code: 'AUTH_USER_SESSIONS_REVOKE_FAILED' },
    });
  });
});
