import { Result } from '@bloodyowl/boxed';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const handler = vi.fn(async (_request: Request) => new Response('provider'));
  const testAuthSecret = ['test', 'auth', 'secret'].join('-');

  return {
    authConfig: {
      allowedHosts: undefined as string[] | undefined,
      githubClientId: undefined as string | undefined,
      githubClientSecret: undefined as string | undefined,
      secret: testAuthSecret,
      sessionExpirationInSeconds: 2_592_000,
      sessionUpdateAgeInSeconds: 86_400,
      trustedOrigins: undefined as string[] | undefined,
    },
    createAuth: vi.fn(() => ({ handler })),
    handler,
  };
});

vi.mock('@/modules/kernel/infrastructure/config/auth', () => ({
  getAuthProviderConfig: () => ({ provider: 'better-auth' }),
  getBetterAuthConfig: () => mocks.authConfig,
}));

vi.mock('@/modules/kernel/backend', () => ({
  createTelemetryLogger: vi.fn(() => ({
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  })),
  getAuthProviderConfig: () => ({ provider: 'better-auth' }),
  getBetterAuthConfig: () => mocks.authConfig,
  getRedisConfig: () => undefined,
}));

vi.mock('@/modules/auth/infrastructure/better-auth/auth', () => ({
  createAuth: mocks.createAuth,
}));

const authEmailPort = {
  sendSignInOtp: vi.fn(async () =>
    Result.Ok({ type: 'auth_sign_in_otp_sent' as const })
  ),
};

describe('auth HTTP gateway exposure policy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.handler.mockResolvedValue(new Response('provider'));
  });

  it('returns 404 for provider administration HTTP endpoints', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const gateway = getAuthHttpGateway({ authEmailPort });
    const response = await gateway.handle(
      new Request('http://localhost/api/auth/admin/remove-user', {
        method: 'POST',
      })
    );

    expect(response.status).toBe(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('forwards explicitly allowed auth endpoints to the provider handler', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const gateway = getAuthHttpGateway({ authEmailPort });
    const response = await gateway.handle(
      new Request('http://localhost/api/auth/sign-in/email-otp', {
        body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    );

    await expect(response.text()).resolves.toBe('provider');
    expect(mocks.handler).toHaveBeenCalledOnce();
  });

  it('returns 404 when the HTTP method does not match the allowlist', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const gateway = getAuthHttpGateway({ authEmailPort });
    const response = await gateway.handle(
      new Request('http://localhost/api/auth/sign-in/email-otp')
    );

    expect(response.status).toBe(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('does not consume the original request body while inspecting it', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');
    const request = new Request(
      'http://localhost/api/auth/email-otp/send-verification-otp',
      {
        body: JSON.stringify({ email: 'user@example.com', type: 'sign-in' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    mocks.handler.mockImplementationOnce(async (forwardedRequest: Request) =>
      Response.json(await forwardedRequest.json())
    );

    const response = await getAuthHttpGateway({ authEmailPort }).handle(
      request
    );

    await expect(response.json()).resolves.toEqual({
      email: 'user@example.com',
      type: 'sign-in',
    });
    expect(mocks.handler).toHaveBeenCalledWith(request);
  });

  it('rejects disallowed OTP payloads before the provider handler', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');
    const request = new Request(
      'http://localhost/api/auth/email-otp/send-verification-otp',
      {
        body: JSON.stringify({
          email: 'user@example.com',
          type: 'forget-password',
        }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );

    const response = await getAuthHttpGateway({ authEmailPort }).handle(
      request
    );

    expect(response.status).toBe(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });
});
