import { toCorrelationId } from '@/modules/kernel';

import { clearProviderAuthSession, getAuthUseCases } from './auth';
import { getKernel } from './kernel';
import { getUserUseCases } from './user';

/**
 * Neutral composition owner for logout. Keeping the user dependency out of
 * auth composition prevents the auth/kernel/user ESM initialization cycle.
 */
export const signOutAuthSession = async (request: Request) => {
  const sessionResult = await getAuthUseCases().getCurrentSession({
    headers: request.headers,
  });
  if (sessionResult.isError()) throw sessionResult.getError();
  const sessionOutcome = sessionResult.get();
  if (sessionOutcome.type === 'auth_session_found') {
    const correlationId = toCorrelationId(crypto.randomUUID());
    if (correlationId.isError()) throw correlationId.getError();
    const signOutResult = await getUserUseCases().signOutCurrentSession({
      correlationId: correlationId.get(),
      currentSessionId: sessionOutcome.session.session.id,
      currentUserId: sessionOutcome.session.user.id,
    });
    if (signOutResult.isError()) throw signOutResult.getError();
  }

  return clearProviderAuthSession(request);
};

export const handleLogoutRequest = (request: Request) =>
  getKernel().telemetry.startSpan(
    {
      attributes: {
        'auth.provider': 'better-auth',
        'http.request.method': request.method,
        'operation.name': 'auth.signOut',
        'operation.type': 'provider_operation',
      },
      name: 'auth.signOut',
      op: 'auth.provider',
    },
    () => signOutAuthSession(request)
  );
