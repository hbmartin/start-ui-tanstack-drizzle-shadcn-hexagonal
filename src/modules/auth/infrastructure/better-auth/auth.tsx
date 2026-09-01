import { Result } from '@bloodyowl/boxed';
import { APIError, betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { emailOTP } from 'better-auth/plugins/email-otp';
import { tanstackStartCookies } from 'better-auth/tanstack-start';
import { match } from 'ts-pattern';

import { AUTH_EMAIL_OTP_EXPIRATION_IN_MINUTES } from '@/modules/auth';
import { isProdRuntimeEnvironment } from '@/modules/kernel/backend';
import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  toEmailAddress,
  toLanguageCode,
  toOtpCode,
} from '@/modules/kernel/domain/ids';
import { getBetterAuthConfig } from '@/modules/kernel/infrastructure/config/auth';
import {
  type Database,
  getDefaultDbClient,
} from '@/modules/kernel/infrastructure/db/client';
import { getUserLanguage } from '@/modules/kernel/transport/tanstack/user-language';
import { envClient } from '@/platform/env/client';

import { createAuthCookieSecurityOptions } from './cookie-options';
import {
  type CreateAuthOptions,
  normalizeCreateAuthInput,
} from './create-auth-options';
import { TRUSTED_AUTH_CLIENT_IP_HEADER } from './auth-http-exposure';

const missingAuthEmailPort = {
  async sendSignInOtp() {
    return Result.Error(
      new AppError({
        code: 'AUTH_EMAIL_PORT_NOT_CONFIGURED',
        category: 'system',
        status: 500,
        message: 'Auth email port is not configured',
      })
    );
  },
};

const invalidAuthProviderResponse = (cause: unknown) =>
  new AppError({
    code: 'AUTH_PROVIDER_RESPONSE_INVALID',
    category: 'system',
    status: 500,
    message: 'Auth provider returned invalid data',
    cause,
  });

const bannedUserError = () =>
  APIError.from('FORBIDDEN', {
    code: 'BANNED_USER',
    message: 'This account is not permitted to sign in',
  });

export function createAuth(input?: Database | CreateAuthOptions) {
  const options = normalizeCreateAuthInput(input);
  const database = options.database ?? getDefaultDbClient();
  const authEmailPort = options.authEmailPort ?? missingAuthEmailPort;
  const authConfig = getBetterAuthConfig();
  const authSignupEnabled = envClient.VITE_AUTH_SIGNUP_ENABLED;

  return betterAuth({
    secret: authConfig.secret,
    baseURL: envClient.VITE_BASE_URL,
    rateLimit: {
      // The app HTTP gateway owns the HMAC-keyed global/network/identity
      // limiter. Disabling the provider middleware prevents Better Auth from
      // collapsing requests without a trusted IP into one denial-of-service
      // bucket while retaining one fail-closed distributed correctness owner.
      enabled: false,
    },
    session: {
      expiresIn: authConfig.sessionExpirationInSeconds,
      updateAge: authConfig.sessionUpdateAgeInSeconds,
      freshAge: authConfig.sessionFreshAgeInSeconds,
      // PostgreSQL is the only session source of truth. Upstash is wired only
      // through the custom rate-limit adapter, so provider session resolution
      // never reads or writes a secondary session/user snapshot.
      storeSessionInDatabase: true,
    },
    verification: {
      storeIdentifier: 'hashed',
      storeInDatabase: true,
    },
    advanced: {
      ...createAuthCookieSecurityOptions(envClient.VITE_BASE_URL, {
        isProduction: isProdRuntimeEnvironment(),
      }),
      ipAddress: {
        // The HTTP gateway strips caller input and writes this single-value
        // header only after applying the configured trusted-proxy topology.
        ipAddressHeaders: [TRUSTED_AUTH_CLIENT_IP_HEADER],
      },
    },
    account: {
      encryptOAuthTokens: true,
    },
    trustedOrigins: authConfig.trustedOrigins,
    database: drizzleAdapter(database, {
      provider: 'pg',
    }),
    databaseHooks: {
      session: {
        create: {
          async before(session, context) {
            if (!context) return;
            const user = await context.context.internalAdapter.findUserById(
              session.userId
            );
            const banState = user as {
              banned?: unknown;
              banExpires?: unknown;
            } | null;
            if (banState?.banned !== true) return;

            const banExpires = banState.banExpires;
            if (
              (banExpires instanceof Date || typeof banExpires === 'string') &&
              new Date(banExpires).getTime() < Date.now()
            ) {
              await context.context.internalAdapter.updateUser(session.userId, {
                banned: false,
                banReason: null,
                banExpires: null,
              });
              return;
            }

            throw bannedUserError();
          },
        },
      },
    },
    user: {
      additionalFields: {
        role: {
          type: 'string',
          required: false,
          input: false,
        },
        banned: {
          type: 'boolean',
          defaultValue: false,
          required: false,
          input: false,
        },
        banReason: {
          type: 'string',
          required: false,
          input: false,
        },
        banExpires: {
          type: 'date',
          required: false,
          input: false,
        },
        onboardedAt: {
          type: 'date',
          // Server-managed workflow flag. `input: false` keeps it out of Better
          // Auth's user-writable input, so a caller cannot self-set it via
          // `POST /api/auth/update-user` to skip onboarding. The onboarding use
          // case writes it directly through the repository. (CWE-915 / CWE-841.)
          input: false,
        },
      },
    },
    onAPIError: {
      throw: true,
      errorURL: '/login/error',
    },
    socialProviders: {
      github: {
        enabled: !!(authConfig.githubClientId && authConfig.githubClientSecret),
        clientId: authConfig.githubClientId!,
        clientSecret: authConfig.githubClientSecret!,
        disableImplicitSignUp: !authSignupEnabled,
        disableSignUp: !authSignupEnabled,
      },
    },

    plugins: [
      emailOTP({
        disableSignUp: !authSignupEnabled,
        expiresIn: AUTH_EMAIL_OTP_EXPIRATION_IN_MINUTES * 60,
        // Encrypt the one-time code at rest (symmetric, keyed by AUTH_SECRET)
        // instead of the Better Auth default of storing it in plaintext in the
        // `verification` table. Defense-in-depth against DB read access.
        // (CWE-256 / CWE-312.)
        storeOTP: 'encrypted',
        allowedAttempts: authConfig.otpAllowedAttempts,
        async sendVerificationOTP({ email, otp, type }) {
          await match(type)
            .with('sign-in', async () => {
              const parsedEmail = toEmailAddress(email);
              if (parsedEmail.isError()) {
                throw invalidAuthProviderResponse(parsedEmail.getError());
              }
              const parsedOtp = toOtpCode(otp);
              if (parsedOtp.isError()) {
                throw invalidAuthProviderResponse(parsedOtp.getError());
              }
              const parsedLanguage = toLanguageCode(getUserLanguage());
              if (parsedLanguage.isError()) {
                throw invalidAuthProviderResponse(parsedLanguage.getError());
              }

              const result = await authEmailPort.sendSignInOtp({
                email: parsedEmail.get(),
                otp: parsedOtp.get(),
                language: parsedLanguage.get(),
              });
              if (result.isError()) throw result.getError();
            })
            .with('email-verification', async () => {
              throw new AppError({
                code: 'AUTH_EMAIL_VERIFICATION_NOT_IMPLEMENTED',
                category: 'system',
                status: 500,
                message:
                  'email-verification email not implemented, update the /app/server/auth.tsx file',
              });
            })
            .with('forget-password', async () => {
              throw new AppError({
                code: 'AUTH_FORGET_PASSWORD_NOT_IMPLEMENTED',
                category: 'system',
                status: 500,
                message:
                  'forget-password email not implemented, update the /app/server/auth.tsx file',
              });
            })
            .with('change-email', async () => {
              throw new AppError({
                code: 'AUTH_CHANGE_EMAIL_NOT_IMPLEMENTED',
                category: 'system',
                status: 500,
                message:
                  'change-email email not implemented, update the /app/server/auth.tsx file',
              });
            })
            .exhaustive();
        },
      }),
      tanstackStartCookies(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;

let defaultAuth: Auth | undefined;

export function getDefaultAuth() {
  defaultAuth ??= createAuth();
  return defaultAuth;
}
