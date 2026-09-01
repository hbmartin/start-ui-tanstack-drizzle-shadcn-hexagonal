import { checkPermission } from './application/use-cases/check-permission';
import { getCurrentSession } from './application/use-cases/get-current-session';
import { sendSignInOtp } from './application/use-cases/send-sign-in-otp';
import type { AuthUseCaseDeps } from './application/use-cases/types';

export function createAuthUseCases(deps: AuthUseCaseDeps) {
  return {
    getCurrentSession: (input: Parameters<typeof getCurrentSession>[1]) =>
      getCurrentSession(deps, input),
    checkPermission: (input: Parameters<typeof checkPermission>[1]) =>
      checkPermission(deps, input),
    sendSignInOtp: (input: Parameters<typeof sendSignInOtp>[1]) =>
      sendSignInOtp(deps, input),
  };
}

export type AuthUseCases = ReturnType<typeof createAuthUseCases>;
