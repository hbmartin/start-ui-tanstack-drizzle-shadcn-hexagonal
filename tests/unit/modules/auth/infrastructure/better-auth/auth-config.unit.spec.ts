import { Result } from '@bloodyowl/boxed';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  betterAuth: vi.fn<(options: ExplicitAny) => ExplicitAny>(() => ({
    handler: vi.fn(),
  })),
  drizzleAdapter: vi.fn(() => ({ id: 'drizzle-adapter' })),
  emailOTP: vi.fn<(options: ExplicitAny) => ExplicitAny>(() => ({
    id: 'email-otp-plugin',
  })),
  tanstackStartCookies: vi.fn(() => ({ id: 'tanstack-cookies-plugin' })),
}));

vi.mock('better-auth', () => ({
  APIError: {
    from: (status: string, body: { code: string; message: string }) =>
      Object.assign(new Error(body.message), { status, body }),
  },
  betterAuth: mocks.betterAuth,
}));

vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: mocks.drizzleAdapter,
}));

vi.mock('better-auth/plugins/email-otp', () => ({ emailOTP: mocks.emailOTP }));

vi.mock('better-auth/tanstack-start', () => ({
  tanstackStartCookies: mocks.tanstackStartCookies,
}));

vi.mock('@/modules/kernel/infrastructure/config/auth', () => ({
  getBetterAuthConfig: () => ({
    githubClientId: undefined,
    githubClientSecret: undefined,
    secret: globalThis.crypto.randomUUID(),
    sessionExpirationInSeconds: 604_800,
    sessionUpdateAgeInSeconds: 86_400,
    sessionFreshAgeInSeconds: 900,
    sessionAbsoluteMaxInSeconds: 2_592_000,
    rateLimitWindowSeconds: 60,
    rateLimitMax: 100,
    rateLimitHmacSecret: 'rate-limit-hmac-secret-that-is-long-enough-for-tests',
    otpAllowedAttempts: 3,
    otpSendWindowSeconds: 60,
    otpSendMax: 3,
    trustedOrigins: ['https://app.example'],
  }),
}));

vi.mock('@/platform/env/client', () => {
  const envClient = {
    DEV: false,
    VITE_AUTH_SIGNUP_ENABLED: false,
    VITE_BASE_URL: 'https://app.example',
  };
  return { envClient, getEnvClient: () => envClient };
});

describe('Better Auth security configuration', () => {
  it('does not disable Better Auth CSRF or origin checks', async () => {
    const { createAuth } = await vi.importActual<
      typeof import('@/modules/auth/infrastructure/better-auth/auth')
    >('@/modules/auth/infrastructure/better-auth/auth');

    createAuth({
      authEmailPort: {
        sendSignInOtp: vi.fn(async () =>
          Result.Ok({ type: 'auth_sign_in_otp_sent' as const })
        ),
      },
    });

    const options = mocks.betterAuth.mock.calls[0]?.[0] as ExplicitAny;

    expect(options.baseURL).toBe('https://app.example');
    expect(options.advanced.disableCSRFCheck).toBeUndefined();
    expect(options.advanced.disableOriginCheck).toBeUndefined();
    expect(options.advanced.ipAddress).toEqual({
      ipAddressHeaders: ['x-start-ui-client-ip'],
    });
    expect(options.account.encryptOAuthTokens).toBe(true);
    expect(options.trustedOrigins).toEqual(['https://app.example']);
    expect(options.socialProviders.github).toMatchObject({
      disableImplicitSignUp: true,
      disableSignUp: true,
    });
    expect(options.plugins).toEqual([
      { id: 'email-otp-plugin' },
      { id: 'tanstack-cookies-plugin' },
    ]);
  });

  it('leaves distributed rate limiting to the app gateway and keeps sessions database-authoritative', async () => {
    const { createAuth } = await vi.importActual<
      typeof import('@/modules/auth/infrastructure/better-auth/auth')
    >('@/modules/auth/infrastructure/better-auth/auth');

    createAuth({
      authEmailPort: {
        sendSignInOtp: vi.fn(async () =>
          Result.Ok({ type: 'auth_sign_in_otp_sent' as const })
        ),
      },
    });

    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as ExplicitAny;

    expect(options.secondaryStorage).toBeUndefined();
    expect(options.rateLimit).toEqual({ enabled: false });
    expect(options.session).toMatchObject({
      expiresIn: 604_800,
      updateAge: 86_400,
      freshAge: 900,
      storeSessionInDatabase: true,
    });
    expect(options.verification).toEqual({
      storeIdentifier: 'hashed',
      storeInDatabase: true,
    });

    const emailOtpOptions = mocks.emailOTP.mock.calls.at(
      -1
    )?.[0] as ExplicitAny;
    expect(emailOtpOptions.disableSignUp).toBe(true);
    expect(emailOtpOptions.allowedAttempts).toBe(3);
    expect(emailOtpOptions.rateLimit).toBeUndefined();
  });

  it('preserves banned-user session enforcement without the admin plugin', async () => {
    const { createAuth } = await vi.importActual<
      typeof import('@/modules/auth/infrastructure/better-auth/auth')
    >('@/modules/auth/infrastructure/better-auth/auth');

    createAuth({
      authEmailPort: {
        sendSignInOtp: vi.fn(async () =>
          Result.Ok({ type: 'auth_sign_in_otp_sent' as const })
        ),
      },
    });
    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as ExplicitAny;
    const beforeSessionCreate = options.databaseHooks.session.create.before;
    const updateUser = vi.fn();

    await expect(
      beforeSessionCreate(
        { userId: 'banned-user' },
        {
          context: {
            internalAdapter: {
              findUserById: vi.fn(async () => ({
                banned: true,
                banExpires: null,
              })),
              updateUser,
            },
          },
        }
      )
    ).rejects.toMatchObject({
      status: 'FORBIDDEN',
      body: { code: 'BANNED_USER' },
    });
    expect(updateUser).not.toHaveBeenCalled();
    expect(options.user.additionalFields).toMatchObject({
      role: { type: 'string', required: false, input: false },
      banned: { type: 'boolean', required: false, input: false },
      banReason: { type: 'string', required: false, input: false },
      banExpires: { type: 'date', required: false, input: false },
    });
  });

  it('clears an expired ban before allowing session creation', async () => {
    const { createAuth } = await vi.importActual<
      typeof import('@/modules/auth/infrastructure/better-auth/auth')
    >('@/modules/auth/infrastructure/better-auth/auth');

    createAuth({
      authEmailPort: {
        sendSignInOtp: vi.fn(async () =>
          Result.Ok({ type: 'auth_sign_in_otp_sent' as const })
        ),
      },
    });
    const options = mocks.betterAuth.mock.calls.at(-1)?.[0] as ExplicitAny;
    const updateUser = vi.fn(async () => undefined);

    await expect(
      options.databaseHooks.session.create.before(
        { userId: 'formerly-banned-user' },
        {
          context: {
            internalAdapter: {
              findUserById: vi.fn(async () => ({
                banned: true,
                banExpires: new Date('2020-01-01T00:00:00.000Z'),
              })),
              updateUser,
            },
          },
        }
      )
    ).resolves.toBeUndefined();
    expect(updateUser).toHaveBeenCalledWith('formerly-banned-user', {
      banned: false,
      banReason: null,
      banExpires: null,
    });
  });
});
