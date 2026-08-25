import { Result } from '@bloodyowl/boxed';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppError } from '@/modules/kernel';

const mocks = vi.hoisted(() => ({
  clearProviderAuthSession: vi.fn(
    async () => new Response(null, { status: 204 })
  ),
  getCurrentSession: vi.fn(),
  signOutCurrentSession: vi.fn(),
  startSpan: vi.fn((_options: unknown, work: () => unknown) => work()),
}));

vi.mock('@/composition/auth', () => ({
  clearProviderAuthSession: mocks.clearProviderAuthSession,
  getAuthUseCases: () => ({ getCurrentSession: mocks.getCurrentSession }),
}));

vi.mock('@/composition/user', () => ({
  getUserUseCases: () => ({
    signOutCurrentSession: mocks.signOutCurrentSession,
  }),
}));

vi.mock('@/composition/kernel', () => ({
  getKernel: () => ({ telemetry: { startSpan: mocks.startSpan } }),
}));

import {
  handleLogoutRequest,
  signOutAuthSession,
} from '@/composition/auth-sign-out';

const foundSession = {
  type: 'auth_session_found' as const,
  session: {
    session: { id: 'session-1' },
    user: { id: 'user-1' },
  },
};

describe('auth sign-out composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getCurrentSession.mockResolvedValue(Result.Ok(foundSession));
    mocks.signOutCurrentSession.mockResolvedValue(
      Result.Ok({ type: 'user_signed_out' as const })
    );
  });

  it('durably revokes and audits the session before clearing the provider cookie', async () => {
    const request = new Request('https://app.example/logout', {
      headers: { cookie: 'session=token' },
      method: 'POST',
    });

    await expect(signOutAuthSession(request)).resolves.toMatchObject({
      status: 204,
    });

    expect(mocks.signOutCurrentSession).toHaveBeenCalledWith({
      correlationId: expect.any(String),
      currentSessionId: 'session-1',
      currentUserId: 'user-1',
    });
    expect(mocks.clearProviderAuthSession).toHaveBeenCalledWith(request);
    expect(
      mocks.signOutCurrentSession.mock.invocationCallOrder[0]!
    ).toBeLessThan(mocks.clearProviderAuthSession.mock.invocationCallOrder[0]!);
  });

  it('wraps the complete logout operation in one telemetry span', async () => {
    const request = new Request('https://app.example/logout', {
      method: 'POST',
    });

    await handleLogoutRequest(request);

    expect(mocks.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'auth.provider': 'better-auth',
          'http.request.method': 'POST',
        }),
        name: 'auth.signOut',
      }),
      expect.any(Function)
    );
  });

  it('leaves the provider cookie intact when durable audit/revocation fails', async () => {
    const failure = new AppError({
      code: 'AUDIT_EVENT_PERSISTENCE_FAILED',
      category: 'system',
      status: 500,
    });
    mocks.signOutCurrentSession.mockResolvedValueOnce(Result.Error(failure));

    await expect(
      signOutAuthSession(new Request('https://app.example/logout'))
    ).rejects.toBe(failure);
    expect(mocks.clearProviderAuthSession).not.toHaveBeenCalled();
  });

  it('clears a stale provider cookie when no durable session remains', async () => {
    mocks.getCurrentSession.mockResolvedValueOnce(
      Result.Ok({ type: 'auth_session_missing' as const })
    );

    await signOutAuthSession(new Request('https://app.example/logout'));

    expect(mocks.signOutCurrentSession).not.toHaveBeenCalled();
    expect(mocks.clearProviderAuthSession).toHaveBeenCalledOnce();
  });
});
