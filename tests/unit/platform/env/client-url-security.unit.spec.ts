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

    expect(() => getEnvClient()).toThrow(/HTTPS in production/);
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

  it('prefers deploy-time process values over Vite build values', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VERCEL_URL', 'runtime.example.com');
    vi.stubEnv('VITE_BASE_URL', 'https://build.example.com');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'https://cdn.example.com/bucket');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient().VITE_BASE_URL).toBe('https://runtime.example.com');
  });

  it('accepts cleartext localhost URLs in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('VITE_BASE_URL', 'http://localhost:3000');
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', 'http://127.0.0.1:9000/default');
    const { getEnvClient } = await import('@/platform/env/config');

    expect(getEnvClient().VITE_BASE_URL).toBe('http://localhost:3000');
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
