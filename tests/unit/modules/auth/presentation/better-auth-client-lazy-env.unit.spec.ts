import { afterEach, describe, expect, it, vi } from 'vitest';

describe('Better Auth browser client environment lifecycle', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it('imports without parsing client configuration and validates on first use', async () => {
    vi.resetModules();
    vi.doUnmock('@/platform/env/client');
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('VITE_BASE_URL', 'not-a-url');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'http://localhost:9000/default');

    const authClient =
      await import('@/modules/auth/presentation/better-auth-client');

    expect(() => authClient.betterAuthBrowserClient.signOut()).toThrow();
  });
});
