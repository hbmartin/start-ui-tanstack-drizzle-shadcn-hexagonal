import {
  adminClient,
  emailOTPClient,
  inferAdditionalFields,
} from 'better-auth/client/plugins';
import { createAccessControl } from 'better-auth/plugins/access';
import { adminAc } from 'better-auth/plugins/admin/access';
import { createAuthClient } from 'better-auth/react';

import { permissionStatements, rolePermissions } from '@/modules/auth';
import { getEnvClient } from '@/platform/env/client';

const ac = createAccessControl(permissionStatements);
const betterAuthClientPermissions = {
  ac,
  roles: {
    admin: ac.newRole({
      ...adminAc.statements,
      ...rolePermissions.admin,
    }),
    user: ac.newRole(rolePermissions.user),
  },
};

const createBetterAuthBrowserClient = () => {
  const env = getEnvClient();
  return createAuthClient({
    baseURL:
      typeof globalThis.window === 'undefined'
        ? env.VITE_BASE_URL
        : globalThis.window.location.origin,
    plugins: [
      inferAdditionalFields({
        user: {
          onboardedAt: {
            type: 'date',
            // Mirror the server: server-managed, not client-writable input.
            input: false,
          },
        },
      }),
      adminClient({
        ...betterAuthClientPermissions,
      }),
      emailOTPClient(),
    ],
  });
};

type BetterAuthBrowserClient = ReturnType<typeof createBetterAuthBrowserClient>;

let betterAuthClient: BetterAuthBrowserClient | undefined;

const getBetterAuthBrowserClient = () =>
  (betterAuthClient ??= createBetterAuthBrowserClient());

export type BetterAuthSocialProvider = Parameters<
  BetterAuthBrowserClient['signIn']['social']
>[0]['provider'];

export const authErrorCodes = new Proxy(
  {} as BetterAuthBrowserClient['$ERROR_CODES'],
  {
    get: (_target, property) =>
      Reflect.get(getBetterAuthBrowserClient().$ERROR_CODES, property),
  }
);

export const betterAuthBrowserClient = {
  sendEmailOtp(input: { email: string }) {
    return getBetterAuthBrowserClient().emailOtp.sendVerificationOtp({
      email: input.email,
      type: 'sign-in',
    });
  },
  signInEmailOtp(input: { email: string; otp: string }) {
    return getBetterAuthBrowserClient().signIn.emailOtp(input);
  },
  signInSocial(input: {
    provider: BetterAuthSocialProvider;
    callbackURL: string;
    errorCallbackURL: string;
  }) {
    return getBetterAuthBrowserClient().signIn.social(input);
  },
  signOut() {
    return getBetterAuthBrowserClient().signOut();
  },
};
