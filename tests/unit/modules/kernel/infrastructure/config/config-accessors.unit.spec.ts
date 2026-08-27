import { makeTestDatabaseUrl } from '@tests/server/test-database-url';
import {
  makeShortTestSecret,
  makeStrongTestSecret,
  makeTestSecret,
} from '@tests/support/test-secrets';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ACTIVE_CAPABILITY_PRESET } from '@/modules/kernel';

const otherCapabilityPreset = {
  core: 'demo',
  demo: 'core',
} as const;

describe('server config accessors', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('SKIP_ENV_VALIDATION', undefined);
    vi.stubEnv('APP_NAME', 'Start UI Test');
    vi.stubEnv('APP_SLUG', 'start-ui-test');
    vi.stubEnv('CAPABILITY_PRESET', ACTIVE_CAPABILITY_PRESET);
    vi.stubEnv(
      'AUTH_RATE_LIMIT_HMAC_SECRET',
      makeStrongTestSecret('rate-limit')
    );
  });

  it.each([
    ['node', 'node-pg'],
    ['vercel', 'neon-http'],
  ] as const)(
    'accepts the %s profile runtime database driver %s',
    async (runtimeProfile, driver) => {
      const { assertDatabaseDriverForRuntimeProfile } =
        await import('@/modules/kernel/infrastructure/config/database');

      expect(() =>
        assertDatabaseDriverForRuntimeProfile(runtimeProfile, { driver })
      ).not.toThrow();
    }
  );

  it.each([
    ['node', 'neon-http'],
    ['node', 'neon-websocket'],
    ['vercel', 'node-pg'],
    ['vercel', 'neon-websocket'],
  ] as const)(
    'rejects %s runtime database driver %s',
    async (runtimeProfile, driver) => {
      const { assertDatabaseDriverForRuntimeProfile } =
        await import('@/modules/kernel/infrastructure/config/database');
      const { ConfigurationError } =
        await import('@/modules/kernel/domain/errors/configuration-error');

      expect(() =>
        assertDatabaseDriverForRuntimeProfile(runtimeProfile, { driver })
      ).toThrow(ConfigurationError);
      expect(() =>
        assertDatabaseDriverForRuntimeProfile(runtimeProfile, { driver })
      ).toThrow(`requires the`);
    }
  );

  it('caches parsed database config', async () => {
    const firstDatabaseUrl = makeTestDatabaseUrl({
      credentialLabel: 'first',
      databaseName: 'first',
    });
    const secondDatabaseUrl = makeTestDatabaseUrl({
      credentialLabel: 'second',
      databaseName: 'second',
    });

    vi.stubEnv('DATABASE_URL', firstDatabaseUrl);
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    const first = getDatabaseConfig();
    vi.stubEnv('DATABASE_URL', secondDatabaseUrl);

    expect(getDatabaseConfig()).toBe(first);
    expect(getDatabaseConfig().databaseUrl).toBe(firstDatabaseUrl);
    expect(getDatabaseConfig().driver).toBe('node-pg');
    expect(getDatabaseConfig().tlsPolicy).toBe('off');
  });

  it('parses explicit database driver config', async () => {
    const databaseUrl = makeTestDatabaseUrl();

    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'neon-http');
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig()).toEqual({
      databaseUrl,
      driver: 'neon-http',
      tlsPolicy: 'off',
    });
  });

  it('parses an explicit encryption-only database policy', async () => {
    const databaseUrl = makeTestDatabaseUrl({ host: 'db.example.com' });

    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_TLS_POLICY', 'encrypt');
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig()).toEqual({
      databaseUrl,
      driver: 'node-pg',
      tlsPolicy: 'encrypt',
    });
  });

  it('rejects a remote database with TLS disabled in every environment', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl({ host: 'db.example.com' }));
    vi.stubEnv('DATABASE_TLS_POLICY', 'off');
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getDatabaseConfig()).toThrow(ConfigurationError);
    expect(() => getDatabaseConfig()).toThrow('loopback');
  });

  it('defaults migration config to node-pg for node-pg runtime drivers', async () => {
    const databaseUrl = makeTestDatabaseUrl();

    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'node-pg');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getMigrationDatabaseConfig()).toEqual({
      databaseUrl,
      driver: 'node-pg',
      tlsPolicy: 'off',
    });
  });

  it.each(['neon-http', 'neon-websocket'] as const)(
    'defaults migration config to Neon WebSocket for %s runtime drivers',
    async (driver) => {
      const databaseUrl = makeTestDatabaseUrl();

      vi.stubEnv('DATABASE_URL', databaseUrl);
      vi.stubEnv('DATABASE_DRIVER', driver);
      const { getMigrationDatabaseConfig } =
        await import('@/modules/kernel/infrastructure/config/database');

      expect(getMigrationDatabaseConfig()).toEqual({
        databaseUrl,
        driver: 'neon-websocket',
        tlsPolicy: 'off',
      });
    }
  );

  it('uses explicit migration URL and driver config', async () => {
    const runtimeDatabaseUrl = makeTestDatabaseUrl({
      credentialLabel: 'runtime',
    });
    const migrationDatabaseUrl = makeTestDatabaseUrl({
      credentialLabel: 'migration',
    });

    vi.stubEnv('DATABASE_URL', runtimeDatabaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'neon-http');
    vi.stubEnv('DATABASE_MIGRATION_URL', migrationDatabaseUrl);
    vi.stubEnv('DATABASE_MIGRATION_DRIVER', 'node-pg');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getMigrationDatabaseConfig()).toEqual({
      databaseUrl: migrationDatabaseUrl,
      driver: 'node-pg',
      tlsPolicy: 'off',
    });
  });

  it('derives verify from a remote migration URL when neither policy is configured', async () => {
    const migrationDatabaseUrl = makeTestDatabaseUrl({
      host: 'db.example.com',
    });

    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv('DATABASE_MIGRATION_URL', migrationDatabaseUrl);
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getMigrationDatabaseConfig()).toEqual({
      databaseUrl: migrationDatabaseUrl,
      driver: 'node-pg',
      tlsPolicy: 'verify',
    });
  });

  it('allows migrations to use a stricter TLS policy than runtime queries', async () => {
    const databaseUrl = makeTestDatabaseUrl();

    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_TLS_POLICY', 'off');
    vi.stubEnv('DATABASE_MIGRATION_TLS_POLICY', 'verify');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getMigrationDatabaseConfig()).toEqual({
      databaseUrl,
      driver: 'node-pg',
      tlsPolicy: 'verify',
    });
  });

  it('requires a remote migration URL to override an inherited off policy', async () => {
    const migrationDatabaseUrl = makeTestDatabaseUrl({
      host: 'db.example.com',
    });

    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv('DATABASE_TLS_POLICY', 'off');
    vi.stubEnv('DATABASE_MIGRATION_URL', migrationDatabaseUrl);
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_MIGRATION_URL uses DATABASE_TLS_POLICY=off, which is allowed only for a loopback endpoint; set DATABASE_MIGRATION_TLS_POLICY=verify for this remote database.'
    );

    vi.stubEnv('DATABASE_MIGRATION_TLS_POLICY', 'verify');
    expect(getMigrationDatabaseConfig()).toEqual({
      databaseUrl: migrationDatabaseUrl,
      driver: 'node-pg',
      tlsPolicy: 'verify',
    });
  });

  it('corrects the shared runtime policy when migrations reuse a remote DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl({ host: 'db.example.com' }));
    vi.stubEnv('DATABASE_TLS_POLICY', 'off');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_URL uses DATABASE_TLS_POLICY=off, which is allowed only for a loopback endpoint; set DATABASE_TLS_POLICY=verify for this remote database.'
    );
  });

  it('attributes an explicit remote migration opt-out to the migration policy', async () => {
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv(
      'DATABASE_MIGRATION_URL',
      makeTestDatabaseUrl({ host: 'db.example.com' })
    );
    vi.stubEnv('DATABASE_MIGRATION_TLS_POLICY', 'off');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_MIGRATION_URL uses DATABASE_MIGRATION_TLS_POLICY=off, which is allowed only for a loopback endpoint; set DATABASE_MIGRATION_TLS_POLICY=verify for this remote database.'
    );
  });

  it('keeps an explicit migration policy scoped when reusing DATABASE_URL', async () => {
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl({ host: 'db.example.com' }));
    vi.stubEnv('DATABASE_MIGRATION_TLS_POLICY', 'off');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_URL uses DATABASE_MIGRATION_TLS_POLICY=off, which is allowed only for a loopback endpoint; set DATABASE_MIGRATION_TLS_POLICY=verify for this remote database.'
    );
  });

  it('corrects the shared runtime policy for Neon migrations using DATABASE_URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl({ host: 'db.example.com' }));
    vi.stubEnv('DATABASE_DRIVER', 'neon-http');
    vi.stubEnv('DATABASE_TLS_POLICY', 'encrypt');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_URL uses a Neon adapter that owns secure transport; production requires DATABASE_TLS_POLICY=verify.'
    );
  });

  it('scopes the Neon policy remedy to a distinct migration URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv('DATABASE_DRIVER', 'neon-http');
    vi.stubEnv('DATABASE_TLS_POLICY', 'encrypt');
    vi.stubEnv(
      'DATABASE_MIGRATION_URL',
      makeTestDatabaseUrl({ host: 'db.example.com' })
    );
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_MIGRATION_URL uses a Neon adapter that owns secure transport; production requires DATABASE_MIGRATION_TLS_POLICY=verify.'
    );
  });

  it('names the runtime policy for a derived Neon policy on shared DATABASE_URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv('DATABASE_DRIVER', 'neon-http');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_URL uses a Neon adapter that owns secure transport; production requires DATABASE_TLS_POLICY=verify.'
    );
  });

  it('names the migration policy for a derived Neon policy on a distinct URL', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv('DATABASE_DRIVER', 'neon-http');
    vi.stubEnv(
      'DATABASE_MIGRATION_URL',
      makeTestDatabaseUrl({ credentialLabel: 'migration' })
    );
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_MIGRATION_URL uses a Neon adapter that owns secure transport; production requires DATABASE_MIGRATION_TLS_POLICY=verify.'
    );
  });

  it('rejects Neon HTTP as a migration driver', async () => {
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv('DATABASE_MIGRATION_DRIVER', 'neon-http');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getMigrationDatabaseConfig()).toThrow(ConfigurationError);
  });

  it('rejects likely transaction-pooled migration URLs', async () => {
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv(
      'DATABASE_MIGRATION_URL',
      makeTestDatabaseUrl({
        host: 'ep-example-pooler.us-east-1.aws.neon.tech',
        port: null,
      })
    );
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getMigrationDatabaseConfig()).toThrow(ConfigurationError);
    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_MIGRATION_URL must use'
    );
  });

  it('attributes a transaction-pooled runtime fallback to DATABASE_URL', async () => {
    vi.stubEnv(
      'DATABASE_URL',
      makeTestDatabaseUrl({
        host: 'ep-example-pooler.us-east-1.aws.neon.tech',
        port: null,
      })
    );
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'set DATABASE_MIGRATION_URL'
    );
  });

  it('detects likely transaction-pooled database URLs', async () => {
    const { isLikelyTransactionPooledDatabaseUrl } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(
      isLikelyTransactionPooledDatabaseUrl(
        makeTestDatabaseUrl({
          databaseName: 'db',
          host: 'ep-example-POOLER.us-east-1.aws.neon.tech',
          port: null,
        })
      )
    ).toBe(true);
    const transactionPoolerSearchParams: ReadonlyArray<Record<string, string>> =
      [
        { pgbouncer: 'true' },
        { PGBOUNCER: 'TRUE' },
        { ' PGBOUNCER ': ' TRUE ' },
        { pool_mode: 'transaction' },
        { POOL_MODE: 'TRANSACTION' },
        { ' POOL_MODE ': ' TRANSACTION ' },
      ];
    for (const searchParams of transactionPoolerSearchParams) {
      expect(
        isLikelyTransactionPooledDatabaseUrl(
          makeTestDatabaseUrl({ databaseName: 'db', searchParams })
        )
      ).toBe(true);
    }
    const duplicateParameterUrl = new URL(
      makeTestDatabaseUrl({ databaseName: 'db' })
    );
    duplicateParameterUrl.searchParams.append('pgbouncer', 'false');
    duplicateParameterUrl.searchParams.append('pgbouncer', 'true');
    expect(
      isLikelyTransactionPooledDatabaseUrl(duplicateParameterUrl.toString())
    ).toBe(true);

    const duplicatePoolModeUrl = new URL(
      makeTestDatabaseUrl({ databaseName: 'db' })
    );
    duplicatePoolModeUrl.searchParams.append('pool_mode', 'session');
    duplicatePoolModeUrl.searchParams.append('pool_mode', 'transaction');
    expect(
      isLikelyTransactionPooledDatabaseUrl(duplicatePoolModeUrl.toString())
    ).toBe(true);
    expect(
      isLikelyTransactionPooledDatabaseUrl(
        makeTestDatabaseUrl({ databaseName: 'db' })
      )
    ).toBe(false);
  });

  it('defaults the auth provider to Better Auth', async () => {
    vi.stubEnv('AUTH_PROVIDER', undefined);
    const { getAuthProviderConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');

    expect(getAuthProviderConfig()).toEqual({ provider: 'better-auth' });
  });

  it('parses canonical application identity and the explicit preset', async () => {
    vi.stubEnv('APP_NAME', 'Acme Cloud');
    vi.stubEnv('APP_SLUG', 'acme-cloud');
    vi.stubEnv('CAPABILITY_PRESET', ACTIVE_CAPABILITY_PRESET);
    const { getApplicationConfig } =
      await import('@/modules/kernel/infrastructure/config/application');

    expect(getApplicationConfig()).toEqual({
      identity: { name: 'Acme Cloud', slug: 'acme-cloud' },
      preset: ACTIVE_CAPABILITY_PRESET,
    });
  });

  it('rejects a preset that differs from the generated composition', async () => {
    vi.stubEnv(
      'CAPABILITY_PRESET',
      otherCapabilityPreset[ACTIVE_CAPABILITY_PRESET]
    );
    const { getApplicationConfig } =
      await import('@/modules/kernel/infrastructure/config/application');

    expect(() => getApplicationConfig()).toThrow(
      'Invalid environment configuration: CAPABILITY_PRESET'
    );
  });

  it('rejects an unstable application slug through ConfigurationError', async () => {
    vi.stubEnv('APP_SLUG', 'Acme Cloud');
    const { getApplicationConfig } =
      await import('@/modules/kernel/infrastructure/config/application');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getApplicationConfig()).toThrow(ConfigurationError);
    expect(() => getApplicationConfig()).toThrow('APP_SLUG');
  });

  it('parses WorkOS as a reserved auth provider without Better Auth secrets', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'workos');
    vi.stubEnv('AUTH_SECRET', undefined);
    const { getAuthProviderConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');

    expect(getAuthProviderConfig()).toEqual({ provider: 'workos' });
  });

  it('rejects reserved auth providers through the Better Auth config accessor', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'workos');
    vi.stubEnv('AUTH_SECRET', undefined);
    const { getAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getAuthConfig()).toThrow(ConfigurationError);
  });

  it('rejects short AUTH_SECRET values without exposing the value', async () => {
    expect.assertions(3);
    const weakAuthValue = makeShortTestSecret('auth');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', weakAuthValue);
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    let error: unknown;
    try {
      getBetterAuthConfig();
    } catch (caughtError) {
      error = caughtError;
    }

    expect(error).toBeInstanceOf(ConfigurationError);
    expect((error as Error).message).toContain('AUTH_SECRET');
    expect((error as Error).message).not.toContain(weakAuthValue);
  });

  it('rejects placeholder AUTH_SECRET values', async () => {
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', 'replace me');
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getBetterAuthConfig()).toThrow(ConfigurationError);
  });

  it('accepts strong AUTH_SECRET values', async () => {
    const authValue = makeStrongTestSecret('auth');
    const rateLimitValue = makeStrongTestSecret('rate-limit');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', authValue);
    vi.stubEnv('AUTH_RATE_LIMIT_HMAC_SECRET', rateLimitValue);
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');

    expect(getBetterAuthConfig().secret).toBe(authValue);
    expect(getBetterAuthConfig().rateLimitHmacSecret).toBe(rateLimitValue);
  });

  it('requires the rate-limit HMAC secret to be distinct from AUTH_SECRET', async () => {
    const sharedValue = makeStrongTestSecret('shared');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', sharedValue);
    vi.stubEnv('AUTH_RATE_LIMIT_HMAC_SECRET', sharedValue);
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getBetterAuthConfig()).toThrow(ConfigurationError);
    expect(() => getBetterAuthConfig()).toThrow('AUTH_RATE_LIMIT_HMAC_SECRET');
  });

  it('allows weak AUTH_SECRET values only when non-production env validation is skipped', async () => {
    const weakAuthValue = makeShortTestSecret('auth');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', weakAuthValue);
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');

    expect(getBetterAuthConfig().secret).toBe(weakAuthValue);
  });

  it('rejects weak AUTH_SECRET values in production even when env validation is skipped', async () => {
    const weakAuthValue = makeShortTestSecret('auth');
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', weakAuthValue);
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getBetterAuthConfig()).toThrow(ConfigurationError);
    expect(() => getBetterAuthConfig()).toThrow('AUTH_SECRET');
  });

  it('rejects placeholder AUTH_SECRET values in production even when env validation is skipped', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('AUTH_PROVIDER', 'better-auth');
    vi.stubEnv('AUTH_SECRET', 'replace me');
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    const { getBetterAuthConfig } =
      await import('@/modules/kernel/infrastructure/config/auth');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getBetterAuthConfig()).toThrow(ConfigurationError);
    expect(() => getBetterAuthConfig()).toThrow('AUTH_SECRET');
  });

  it('skips server config validation outside production when SKIP_ENV_VALIDATION is true', async () => {
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    vi.stubEnv('AUTH_SECRET', undefined);
    vi.stubEnv('DATABASE_URL', undefined);

    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig('node')).not.toThrow();
  });

  it('runs server config validation in production even when SKIP_ENV_VALIDATION is true', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('APP_DOMAIN', 'https://app.example.test');
    vi.stubEnv('SKIP_ENV_VALIDATION', 'true');
    vi.stubEnv('AUTH_SECRET', undefined);
    vi.stubEnv('DATABASE_URL', undefined);
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig('node')).toThrow(ConfigurationError);
  });

  it('returns null for absent optional Redis config', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');

    expect(getRedisConfig()).toBeNull();
  });

  it('requires distributed Redis rate limiting at production startup', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
    expect(() => getRedisConfig()).toThrow('Production startup requires');
  });

  it('allows production build validation to omit runtime Redis credentials without weakening startup', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');

    expect(getRedisConfig({ requiredInProduction: false })).toBeNull();
    expect(() => getRedisConfig()).toThrow('Production startup requires');
  });

  it('throws ConfigurationError for partial optional Redis config', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
    expect(() => getRedisConfig()).toThrow('UPSTASH_REDIS_REST_TOKEN');
  });

  it('rejects Redis URL credentials without exposing them', async () => {
    vi.stubEnv(
      'UPSTASH_REDIS_REST_URL',
      'https://embedded-user:embedded-secret@redis.example.com'
    );
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');

    let caught: unknown;
    try {
      getRedisConfig();
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toContain('must not contain URL credentials');
    expect(String(caught)).not.toContain('embedded-secret');
  });

  it('throws ConfigurationError when Redis token is present without URL', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', undefined);
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
    expect(() => getRedisConfig()).toThrow('UPSTASH_REDIS_REST_URL');
  });

  it('returns Redis config when both required values are present', async () => {
    const redisToken = makeTestSecret('redis');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', redisToken);
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');

    expect(getRedisConfig()).toEqual({
      restUrl: 'https://redis.example.com',
      restToken: redisToken,
    });
  });

  it('throws ConfigurationError for malformed Redis config', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'not-a-url');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
  });

  it('reports Redis as configured only when both values are present', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { isRedisConfigured } =
      await import('@/modules/kernel/infrastructure/config/redis');

    expect(isRedisConfigured()).toBe(true);
  });

  it('throws ConfigurationError when checking partial Redis config', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', undefined);
    const { isRedisConfigured } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => isRedisConfigured()).toThrow(ConfigurationError);
  });

  it('throws ConfigurationError when checking a malformed Redis URL', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'not-a-url');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { isRedisConfigured } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => isRedisConfigured()).toThrow(ConfigurationError);
  });

  it('accepts LOGGER_PRETTY as a legacy console mirror alias', async () => {
    vi.stubEnv('LOGGER_CONSOLE_MIRROR', undefined);
    vi.stubEnv('LOGGER_PRETTY', 'false');
    const { getLoggerConfig } =
      await import('@/modules/kernel/infrastructure/config/logger');

    expect(getLoggerConfig().consoleMirror).toBe(false);
  });

  it('prefers LOGGER_CONSOLE_MIRROR over legacy LOGGER_PRETTY', async () => {
    vi.stubEnv('LOGGER_CONSOLE_MIRROR', 'true');
    vi.stubEnv('LOGGER_PRETTY', 'false');
    const { getLoggerConfig } =
      await import('@/modules/kernel/infrastructure/config/logger');

    expect(getLoggerConfig().consoleMirror).toBe(true);
  });

  it('uses safe no-export telemetry defaults in production without a Collector', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', undefined);
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig()).toMatchObject({
      collectorUrl: undefined,
      localSqliteEnabled: false,
      otelSdkDisabled: false,
    });
  });

  it('exposes the Vercel SDK disabled state through validated telemetry config', async () => {
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().otelSdkDisabled).toBe(true);
  });

  it.each(['false', '0', 'TRUE-ish'])(
    'keeps Vercel telemetry enabled for non-true OTEL_SDK_DISABLED=%s',
    async (value) => {
      vi.stubEnv('OTEL_SDK_DISABLED', value);
      const { getTelemetryConfig } =
        await import('@/modules/kernel/infrastructure/config/telemetry');

      expect(getTelemetryConfig().otelSdkDisabled).toBe(false);
    }
  );

  it('accepts production telemetry config when the Collector URL is present', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', 'https://collector.example/v1');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().collectorUrl).toBe(
      'https://collector.example/v1'
    );
  });

  it('rejects cleartext production OpenTelemetry collector URLs outside localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', 'http://collector.example/v1');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getTelemetryConfig()).toThrow(ConfigurationError);
    expect(() => getTelemetryConfig()).toThrow('OTEL_COLLECTOR_URL');
  });

  it('accepts cleartext production OpenTelemetry collector URLs for IPv6 loopback', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', 'http://[::1]:4318/v1/traces');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().collectorUrl).toBe(
      'http://[::1]:4318/v1/traces'
    );
  });

  it('rejects cleartext production S3 transport for non-local storage hosts', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('S3_ACCESS_KEY_ID', makeTestSecret('s3-access-key'));
    vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
    vi.stubEnv('S3_HOST', 'storage.example.com');
    vi.stubEnv('S3_SECURE', 'false');
    const { getStorageConfig } =
      await import('@/modules/kernel/infrastructure/config/storage');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getStorageConfig()).toThrow(ConfigurationError);
    expect(() => getStorageConfig()).toThrow('S3_SECURE');
  });

  it.each([
    '[::1]:9000',
    '::1:9000',
    '::1',
    '::1/uploads',
    'http://[::1]:9000',
  ])(
    'accepts cleartext production S3 transport for IPv6 loopback host %s',
    async (host) => {
      vi.stubEnv('NODE_ENV', 'production');
      vi.stubEnv('S3_ACCESS_KEY_ID', makeTestSecret('s3-access-key'));
      vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
      vi.stubEnv('S3_HOST', host);
      vi.stubEnv('S3_SECURE', 'false');
      const { getStorageConfig } =
        await import('@/modules/kernel/infrastructure/config/storage');

      expect(getStorageConfig()).toMatchObject({
        host,
        secure: false,
      });
    }
  );

  it('rejects cleartext production S3 transport for non-loopback IPv6 hosts', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('S3_ACCESS_KEY_ID', makeTestSecret('s3-access-key'));
    vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
    vi.stubEnv('S3_HOST', '2001:db8::1');
    vi.stubEnv('S3_SECURE', 'false');
    const { getStorageConfig } =
      await import('@/modules/kernel/infrastructure/config/storage');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getStorageConfig()).toThrow(ConfigurationError);
    expect(() => getStorageConfig()).toThrow('S3_SECURE');
  });

  it('rejects cleartext production S3 transport when the storage host is malformed', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('S3_ACCESS_KEY_ID', makeTestSecret('s3-access-key'));
    vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
    vi.stubEnv('S3_HOST', 'http://[');
    vi.stubEnv('S3_SECURE', 'false');
    const { getStorageConfig } =
      await import('@/modules/kernel/infrastructure/config/storage');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getStorageConfig()).toThrow(ConfigurationError);
    expect(() => getStorageConfig()).toThrow('S3_SECURE');
  });

  it('rejects placeholder production S3 credentials', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('S3_ACCESS_KEY_ID', 'startui-access-key');
    vi.stubEnv('S3_SECRET_ACCESS_KEY', makeTestSecret('s3-secret-key'));
    vi.stubEnv('S3_HOST', 'storage.example.com');
    vi.stubEnv('S3_SECURE', 'true');
    const { getStorageConfig } =
      await import('@/modules/kernel/infrastructure/config/storage');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getStorageConfig()).toThrow(ConfigurationError);
    expect(() => getStorageConfig()).toThrow('S3_ACCESS_KEY_ID');
  });

  it('defaults the Resend webhook body limit to one megabyte', async () => {
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('RESEND_WEBHOOK_MAX_BYTES', undefined);
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig().resendWebhookMaxBytes).toBe(1_000_000);
  });

  it('parses an explicit Resend webhook body limit', async () => {
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('RESEND_WEBHOOK_MAX_BYTES', '4096');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig().resendWebhookMaxBytes).toBe(4096);
  });

  it('parses an explicit SMTP email server', async () => {
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', 'smtp://127.0.0.1:1025');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig().server).toBe('smtp://127.0.0.1:1025');
  });

  it('does not require Resend credentials for SMTP email delivery', async () => {
    vi.stubEnv('RESEND_API_KEY', undefined);
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', 'smtp://127.0.0.1:1025');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig()).toMatchObject({
      resendApiKey: undefined,
      server: 'smtp://127.0.0.1:1025',
    });
  });

  it('requires Resend credentials when SMTP email delivery is not configured', async () => {
    vi.stubEnv('RESEND_API_KEY', undefined);
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getEmailConfig()).toThrow(ConfigurationError);
    expect(() => getEmailConfig()).toThrow('RESEND_API_KEY');
  });

  it('allows email adapters to remain unconfigured when delivery is disabled', async () => {
    vi.stubEnv('RESEND_API_KEY', '');
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', '');
    vi.stubEnv('EMAIL_DELIVERY_DISABLED', 'true');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');

    expect(getEmailConfig()).toMatchObject({
      deliveryDisabled: true,
      resendApiKey: undefined,
      server: undefined,
    });
  });

  it('rejects unsupported email server protocols', async () => {
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', 'https://mail.example.com');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getEmailConfig()).toThrow(ConfigurationError);
    expect(() => getEmailConfig()).toThrow('EMAIL_SERVER');
  });

  it('rejects SMTP email server configuration in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    vi.stubEnv('EMAIL_SERVER', 'smtp://127.0.0.1:1025');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getEmailConfig()).toThrow(ConfigurationError);
    expect(() => getEmailConfig()).toThrow('EMAIL_SERVER');
  });

  it('rejects placeholder production Resend webhook secrets', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('RESEND_API_KEY', makeTestSecret('resend-api-key'));
    vi.stubEnv('RESEND_WEBHOOK_SECRET', 'REPLACE ME');
    vi.stubEnv('EMAIL_FROM', 'Start UI <noreply@example.com>');
    const { getEmailConfig } =
      await import('@/modules/kernel/infrastructure/config/email');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getEmailConfig()).toThrow(ConfigurationError);
    expect(() => getEmailConfig()).toThrow('RESEND_WEBHOOK_SECRET');
  });

  it('defaults production node-pg database transport to verification', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl({ host: 'db.example.com' }));
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig().tlsPolicy).toBe('verify');
  });

  it('rejects URL TLS parameters even when they request verification', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const databaseUrl = makeTestDatabaseUrl({
      host: 'db.example.com',
      searchParams: { sslmode: 'verify-full' },
    });
    vi.stubEnv('DATABASE_URL', databaseUrl);
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getDatabaseConfig()).toThrow(ConfigurationError);
    expect(() => getDatabaseConfig()).toThrow(
      'DATABASE_URL must not configure endpoint or TLS parameters in the URL (sslmode); remove those parameters, keep the endpoint in the URL authority, and configure TLS with DATABASE_TLS_POLICY.'
    );
  });

  it('allows an explicit loopback-only off policy for production verification', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const databaseUrl = makeTestDatabaseUrl();
    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_TLS_POLICY', 'off');
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig()).toMatchObject({
      databaseUrl,
      tlsPolicy: 'off',
    });
  });

  it('requires the adapter-owned verify policy for Neon in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const databaseUrl = makeTestDatabaseUrl({ host: 'db.example.com' });
    vi.stubEnv('DATABASE_URL', databaseUrl);
    vi.stubEnv('DATABASE_DRIVER', 'neon-websocket');
    const { getDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(getDatabaseConfig()).toMatchObject({
      databaseUrl,
      tlsPolicy: 'verify',
    });
  });

  it('rejects URL-owned TLS parameters for production migration URLs', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('DATABASE_URL', makeTestDatabaseUrl());
    vi.stubEnv(
      'DATABASE_MIGRATION_URL',
      makeTestDatabaseUrl({
        host: 'db.example.com',
        searchParams: { sslmode: 'verify-full' },
      })
    );
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getMigrationDatabaseConfig()).toThrow(ConfigurationError);
    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_MIGRATION_URL must not configure endpoint or TLS parameters in the URL (sslmode); remove those parameters, keep the endpoint in the URL authority, and configure TLS with DATABASE_MIGRATION_TLS_POLICY.'
    );
  });

  it('uses runtime URL ownership for shared migration URL parameters', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv(
      'DATABASE_URL',
      makeTestDatabaseUrl({
        host: 'db.example.com',
        searchParams: { sslmode: 'verify-full' },
      })
    );
    vi.stubEnv('DATABASE_MIGRATION_TLS_POLICY', 'verify');
    const { getMigrationDatabaseConfig } =
      await import('@/modules/kernel/infrastructure/config/database');

    expect(() => getMigrationDatabaseConfig()).toThrow(
      'DATABASE_URL must not configure endpoint or TLS parameters in the URL (sslmode); remove those parameters, keep the endpoint in the URL authority, and configure runtime TLS with DATABASE_TLS_POLICY and migration TLS with DATABASE_MIGRATION_TLS_POLICY.'
    );
  });

  it('rejects cleartext production Redis REST URLs outside localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'http://redis.example.com');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', makeTestSecret('redis'));
    const { getRedisConfig } =
      await import('@/modules/kernel/infrastructure/config/redis');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getRedisConfig()).toThrow(ConfigurationError);
    expect(() => getRedisConfig()).toThrow('UPSTASH_REDIS_REST_URL');
  });

  it('defaults the trusted proxy depth to one hop', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', undefined);
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');

    expect(getHttpConfig().trustedProxyDepth).toBe(1);
  });

  it('parses an explicit positive trusted proxy depth', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', '2');
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');

    expect(getHttpConfig().trustedProxyDepth).toBe(2);
  });

  it('treats an empty trusted proxy depth as unset', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', '   ');
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');

    expect(getHttpConfig().trustedProxyDepth).toBe(1);
  });

  it('does not implicitly trust caller XFF in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('TRUSTED_PROXY_DEPTH', undefined);
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');

    expect(getHttpConfig().trustedProxyDepth).toBeUndefined();
  });

  it('accepts zero to disable proxy-header trust at a direct origin', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', '0');
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');

    expect(getHttpConfig().trustedProxyDepth).toBe(0);
  });

  it('rejects a negative trusted proxy depth', async () => {
    vi.stubEnv('TRUSTED_PROXY_DEPTH', '-1');
    const { getHttpConfig } =
      await import('@/modules/kernel/infrastructure/config/http');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getHttpConfig()).toThrow(ConfigurationError);
  });

  it('defaults telemetry proxy auth to disabled', async () => {
    vi.stubEnv('TELEMETRY_REQUIRE_AUTH', undefined);
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().requireAuth).toBe(false);
  });

  it('parses an explicit telemetry proxy auth requirement', async () => {
    vi.stubEnv('TELEMETRY_REQUIRE_AUTH', 'true');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');

    expect(getTelemetryConfig().requireAuth).toBe(true);
  });

  it('rejects cleartext production Sentry DSNs outside localhost', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('OTEL_COLLECTOR_URL', 'https://collector.example/v1');
    vi.stubEnv('SENTRY_DSN', 'http://public@sentry.example.com/1');
    const { getTelemetryConfig } =
      await import('@/modules/kernel/infrastructure/config/telemetry');
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getTelemetryConfig()).toThrow(ConfigurationError);
    expect(() => getTelemetryConfig()).toThrow('SENTRY_DSN');
  });
});
