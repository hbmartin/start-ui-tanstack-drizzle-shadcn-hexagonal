import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('getEnvClient URL security', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('APP_NAME', 'Start UI Test');
    vi.stubEnv('APP_SLUG', 'start-ui-test');
  });

  it('rejects cleartext VITE_BASE_URL for remote hosts in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'http://app.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'https://cdn.example.com/bucket');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient()).toThrow(/must use HTTPS/);
  });

  it('rejects cleartext VITE_S3_BUCKET_PUBLIC_URL for remote hosts in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'https://app.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'http://cdn.example.com/bucket');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient()).toThrow(/VITE_S3_BUCKET_PUBLIC_URL/);
  });

  it('accepts https production URLs', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'https://app.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'https://cdn.example.com/bucket');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient().VITE_BASE_URL).toBe('https://app.example.com');
  });

  it('uses Vercel production URL precedence for the Vercel profile', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'production.example.com');
    vi.stubEnv('VERCEL_URL', 'runtime.example.com');
    vi.stubEnv('VITE_BASE_URL', 'https://build.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'https://cdn.example.com/bucket');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient('vercel').VITE_BASE_URL).toBe(
      'https://production.example.com'
    );
  });

  it('falls back to VERCEL_URL when the production URL is blank', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', '  ');
    vi.stubEnv('VERCEL_URL', 'preview.example.com');
    vi.stubEnv('VITE_BASE_URL', 'https://build.example.com');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient('vercel').VITE_BASE_URL).toBe(
      'https://preview.example.com'
    );
  });

  it('uses APP_DOMAIN for Node and ignores ambient Vercel variables', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_DOMAIN', 'https://node.example.com');
    vi.stubEnv('VERCEL_PROJECT_PRODUCTION_URL', 'vercel.example.com');
    vi.stubEnv('VITE_BASE_URL', 'https://build.example.com');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient('node').VITE_BASE_URL).toBe('https://node.example.com');
  });

  it('requires APP_DOMAIN to be an explicit origin', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_DOMAIN', 'node.example.com');
    vi.stubEnv('VITE_BASE_URL', 'https://build.example.com');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient('node')).toThrow(/valid HTTP\(S\) origin/);
  });

  it.each(['node', 'cloudflare'] as const)(
    'requires APP_DOMAIN for production %s',
    async (profile) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('VITE_BASE_URL', 'https://build.example.com');
      const { getEnvClient } = await import('@/platform/env/config');

      expect(() => getEnvClient(profile)).toThrow(/APP_DOMAIN is required/);
    }
  );

  it.each([
    'https://user:secret@app.example.com',
    'https://app.example.com/path',
    'https://app.example.com?debug=true',
    'https://app.example.com#fragment',
  ])('rejects non-origin APP_DOMAIN value %s', async (appDomain) => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_DOMAIN', appDomain);
    vi.stubEnv('VITE_BASE_URL', 'https://build.example.com');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient('node')).toThrow(/must contain only an origin/);
  });

  it('rejects cleartext localhost origins in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_DOMAIN', 'http://localhost:3000');
    vi.stubEnv('VITE_BASE_URL', 'https://build.example.com');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient('node')).toThrow(/must use HTTPS/);
  });

  it('accepts cleartext localhost only outside production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VITE_BASE_URL', 'http://localhost:3000');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient('node').VITE_BASE_URL).toBe('http://localhost:3000');
  });

  it('rejects cleartext VITE_SENTRY_DSN for remote hosts in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'https://app.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'https://cdn.example.com/bucket');
    vi.stubEnv('VITE_SENTRY_DSN', 'http://sentry.example.com/1');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(() => getEnvClient()).toThrow(/VITE_SENTRY_DSN/);
  });

  it('defaults public signup to disabled', async () => {
    const { parseClientEnv } = await import('@/platform/env/config');

    expect(
      parseClientEnv({
        APP_NAME: 'Start UI Test',
        APP_SLUG: 'start-ui-test',
        VITE_BASE_URL: 'http://localhost:3000',
        VITE_S3_BUCKET_PUBLIC_URL: 'http://localhost:9000/default',
      }).VITE_AUTH_SIGNUP_ENABLED
    ).toBe(false);
  });

  it('requires an explicit opt-in to public signup', async () => {
    const { parseClientEnv } = await import('@/platform/env/config');

    expect(
      parseClientEnv({
        APP_NAME: 'Start UI Test',
        APP_SLUG: 'start-ui-test',
        VITE_AUTH_SIGNUP_ENABLED: 'true',
        VITE_BASE_URL: 'http://localhost:3000',
        VITE_S3_BUCKET_PUBLIC_URL: 'http://localhost:9000/default',
      }).VITE_AUTH_SIGNUP_ENABLED
    ).toBe(true);
  });

  it('uses the shared application identity contract', async () => {
    const { parseClientEnv } = await import('@/platform/env/config');

    expect(
      parseClientEnv({
        APP_NAME: 'Acme Cloud',
        APP_SLUG: 'acme-cloud',
        VITE_BASE_URL: 'http://localhost:3000',
      })
    ).toMatchObject({ APP_NAME: 'Acme Cloud', APP_SLUG: 'acme-cloud' });
    expect(() =>
      parseClientEnv({
        APP_NAME: 'Acme Cloud',
        APP_SLUG: 'Acme Cloud',
        VITE_BASE_URL: 'http://localhost:3000',
      })
    ).toThrow();
  });

  it('rejects control characters in the application presentation name', async () => {
    const { parseClientEnv } = await import('@/platform/env/config');

    expect(() =>
      parseClientEnv({
        APP_NAME: 'Acme\r\nBcc: victim@example.com',
        APP_SLUG: 'acme-cloud',
        VITE_BASE_URL: 'http://localhost:3000',
      })
    ).toThrow();
  });
});
