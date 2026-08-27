import { Result } from '@bloodyowl/boxed';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SecondaryStore } from '@/modules/auth';
import { AppError } from '@/modules/kernel';

const mocks = vi.hoisted(() => {
  const handler = vi.fn(async (_request: Request) => new Response('provider'));
  const testAuthSecret = ['test', 'auth', 'secret'].join('-');

  return {
    authConfig: {
      githubClientId: undefined as string | undefined,
      githubClientSecret: undefined as string | undefined,
      secret: testAuthSecret,
      sessionExpirationInSeconds: 2_592_000,
      sessionUpdateAgeInSeconds: 86_400,
      otpSendMax: 3,
      otpSendWindowSeconds: 60,
      rateLimitMax: 100,
      rateLimitHmacSecret:
        'rate-limit-hmac-secret-that-is-long-enough-for-tests',
      rateLimitWindowSeconds: 60,
      trustedOrigins: undefined as string[] | undefined,
    },
    createAuth: vi.fn(() => ({ handler })),
    handler,
    isProd: false,
    trustedProxyDepth: 1 as number | undefined,
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
  getHttpConfig: () => ({ trustedProxyDepth: mocks.trustedProxyDepth }),
  getRedisConfig: () => undefined,
  isProdRuntimeEnvironment: () => mocks.isProd,
}));

vi.mock('@/modules/auth/infrastructure/better-auth/auth', () => ({
  createAuth: mocks.createAuth,
}));

const authEmailPort = {
  sendSignInOtp: vi.fn(async () =>
    Result.Ok({ type: 'auth_sign_in_otp_sent' as const })
  ),
};

const makeSecondaryStore = () =>
  ({
    delete: vi.fn(async () =>
      Result.Ok({ type: 'secondary_store_deleted' as const })
    ),
    get: vi.fn(async () =>
      Result.Ok({ type: 'secondary_store_miss' as const })
    ),
    set: vi.fn(async () => Result.Ok({ type: 'secondary_store_set' as const })),
    take: vi.fn(async () =>
      Result.Ok({ type: 'secondary_store_miss' as const })
    ),
    consumeRateLimit: vi.fn<SecondaryStore['consumeRateLimit']>(async () =>
      Result.Ok({
        allowed: true,
        retryAfter: null,
        type: 'secondary_store_rate_limit_consumed' as const,
      })
    ),
  }) satisfies SecondaryStore;

describe('auth HTTP gateway exposure policy', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.isProd = false;
    mocks.trustedProxyDepth = 1;
    mocks.handler.mockResolvedValue(new Response('provider'));
  });

  it('fails startup closed when production has no distributed rate-limit store', async () => {
    mocks.isProd = true;
    const { getSecondaryStore } = await import('@/composition/auth');

    expect(() => getSecondaryStore()).toThrow(
      'Production auth requires UPSTASH_REDIS_REST_URL'
    );
  });

  it('returns 404 for provider administration HTTP endpoints', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const gateway = getAuthHttpGateway({ authEmailPort });
    const response = await gateway.handle(
      new Request('http://localhost/api/auth/admin/remove-user', {
        method: 'POST',
      }),
      'node'
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
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.7',
        },
        method: 'POST',
      }),
      'node'
    );

    await expect(response.text()).resolves.toBe('provider');
    expect(mocks.handler).toHaveBeenCalledOnce();
  });

  it('returns 404 when the HTTP method does not match the allowlist', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const gateway = getAuthHttpGateway({ authEmailPort });
    const response = await gateway.handle(
      new Request('http://localhost/api/auth/sign-in/email-otp'),
      'node'
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
      request,
      'node'
    );

    await expect(response.json()).resolves.toEqual({
      email: 'user@example.com',
      type: 'sign-in',
    });
    const forwardedRequest = mocks.handler.mock.calls[0]?.[0];
    expect(forwardedRequest).toBeInstanceOf(Request);
    expect(forwardedRequest).not.toBe(request);
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
      request,
      'node'
    );

    expect(response.status).toBe(404);
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('replaces a caller-supplied internal IP with the topology-derived client IP', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');
    const request = new Request('http://localhost/api/auth/sign-in/email-otp', {
      body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.10, 203.0.113.7',
        'x-start-ui-client-ip': '192.0.2.99',
      },
      method: 'POST',
    });

    await getAuthHttpGateway({ authEmailPort }).handle(request, 'node');

    const forwardedRequest = mocks.handler.mock.calls[0]?.[0] as Request;
    expect(forwardedRequest.headers.get('x-start-ui-client-ip')).toBe(
      '203.0.113.7'
    );
  });

  it.each([
    {
      expected: '203.0.113.8',
      headers: {
        'cf-connecting-ip': '192.0.2.1',
        'x-forwarded-for': '198.51.100.1',
        'x-vercel-forwarded-for': '203.0.113.8',
      },
      profile: 'vercel' as const,
    },
    {
      expected: '203.0.113.9',
      headers: {
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '198.51.100.2',
        'x-vercel-forwarded-for': '192.0.2.2',
      },
      profile: 'cloudflare' as const,
    },
  ])(
    'trusts only the $profile client-IP header',
    async ({ expected, headers, profile }) => {
      const { getAuthHttpGateway } = await import('@/composition/auth');

      await getAuthHttpGateway({ authEmailPort }).handle(
        new Request('http://localhost/api/auth/sign-in/email-otp', {
          body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
          headers: {
            ...headers,
            'content-type': 'application/json',
            'x-start-ui-client-ip': '192.0.2.99',
          },
          method: 'POST',
        }),
        profile
      );

      const forwardedRequest = mocks.handler.mock.calls[0]?.[0] as Request;
      expect(forwardedRequest.headers.get('x-start-ui-client-ip')).toBe(
        expected
      );
    }
  );

  it('fails production auth closed when profile-owned IP provenance is absent', async () => {
    mocks.isProd = true;
    const secondaryStore = makeSecondaryStore();
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const response = await getAuthHttpGateway({
      authEmailPort,
      secondaryStore,
    }).handle(
      new Request('http://localhost/api/auth/sign-in/email-otp', {
        body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.7',
        },
        method: 'POST',
      }),
      'vercel'
    );

    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.json()).resolves.toEqual({
      error: 'rate_limiter_unavailable',
    });
    expect(secondaryStore.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('does not accept caller XFF when Node production proxy trust is unset', async () => {
    mocks.isProd = true;
    mocks.trustedProxyDepth = undefined;
    const secondaryStore = makeSecondaryStore();
    const { getAuthHttpGateway } = await import('@/composition/auth');

    const response = await getAuthHttpGateway({
      authEmailPort,
      secondaryStore,
    }).handle(
      new Request('http://localhost/api/auth/sign-in/email-otp', {
        body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.7',
        },
        method: 'POST',
      }),
      'node'
    );

    expect(response.status).toBe(503);
    expect(secondaryStore.consumeRateLimit).not.toHaveBeenCalled();
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('adds a bounded standard Retry-After header to provider 429 responses', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');
    mocks.handler.mockResolvedValueOnce(
      new Response('limited', {
        headers: { 'X-Retry-After': '9999' },
        status: 429,
      })
    );

    const response = await getAuthHttpGateway({ authEmailPort }).handle(
      new Request('http://localhost/api/auth/sign-in/email-otp', {
        body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      'node'
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    await expect(response.text()).resolves.toBe('limited');
  });

  it('HMAC-keys independent global, trusted-network, and identity limits', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');
    const secondaryStore = makeSecondaryStore();

    const response = await getAuthHttpGateway({
      authEmailPort,
      secondaryStore,
    }).handle(
      new Request('http://localhost/api/auth/sign-in/email-otp', {
        body: JSON.stringify({ email: 'User@Example.COM', otp: '123456' }),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.7',
        },
        method: 'POST',
      }),
      'node'
    );

    expect(response.status).toBe(200);
    expect(secondaryStore.consumeRateLimit).toHaveBeenCalledTimes(3);
    for (const [key] of secondaryStore.consumeRateLimit.mock.calls) {
      expect(key).toMatch(/^better-auth:rate-limit:v1:[a-f0-9]{64}$/u);
      expect(key).not.toContain('user@example.com');
      expect(key).not.toContain('203.0.113.7');
    }
  });

  it('skips the shared network bucket when direct-origin mode has no trusted IP provenance', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');
    const secondaryStore = makeSecondaryStore();
    mocks.trustedProxyDepth = 0;

    const response = await getAuthHttpGateway({
      authEmailPort,
      secondaryStore,
    }).handle(
      new Request('http://localhost/api/auth/sign-in/email-otp', {
        body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.7',
        },
        method: 'POST',
      }),
      'node'
    );

    expect(response.status).toBe(200);
    expect(secondaryStore.consumeRateLimit).toHaveBeenCalledTimes(2);
    const forwardedRequest = mocks.handler.mock.calls[0]?.[0] as Request;
    expect(forwardedRequest.headers.has('x-start-ui-client-ip')).toBe(false);
  });

  it('returns a real bounded 429 when the identity layer is exhausted', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');
    const secondaryStore = makeSecondaryStore();
    secondaryStore.consumeRateLimit
      .mockResolvedValueOnce(
        Result.Ok({
          allowed: true,
          retryAfter: null,
          type: 'secondary_store_rate_limit_consumed',
        })
      )
      .mockResolvedValueOnce(
        Result.Ok({
          allowed: true,
          retryAfter: null,
          type: 'secondary_store_rate_limit_consumed',
        })
      )
      .mockResolvedValueOnce(
        Result.Ok({
          allowed: false,
          retryAfter: 999,
          type: 'secondary_store_rate_limit_consumed',
        })
      );

    const response = await getAuthHttpGateway({
      authEmailPort,
      secondaryStore,
    }).handle(
      new Request('http://localhost/api/auth/email-otp/send-verification-otp', {
        body: JSON.stringify({
          email: 'user@example.com',
          type: 'sign-in',
        }),
        headers: {
          'content-type': 'application/json',
          'x-forwarded-for': '203.0.113.7',
        },
        method: 'POST',
      }),
      'node'
    );

    expect(response.status).toBe(429);
    expect(response.headers.get('Retry-After')).toBe('60');
    expect(mocks.handler).not.toHaveBeenCalled();
  });

  it('fails closed before the provider when distributed limiting is unavailable', async () => {
    const { getAuthHttpGateway } = await import('@/composition/auth');
    const secondaryStore = makeSecondaryStore();
    const failure = new AppError({
      code: 'AUTH_SECONDARY_STORE_TEST_FAILURE',
      category: 'system',
      status: 503,
    });
    secondaryStore.consumeRateLimit.mockResolvedValueOnce(
      Result.Error(failure)
    );

    await expect(
      getAuthHttpGateway({ authEmailPort, secondaryStore }).handle(
        new Request('http://localhost/api/auth/sign-in/email-otp', {
          body: JSON.stringify({ email: 'user@example.com', otp: '123456' }),
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        'node'
      )
    ).rejects.toBe(failure);
    expect(mocks.handler).not.toHaveBeenCalled();
  });
});
