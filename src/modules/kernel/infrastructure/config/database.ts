import { z } from 'zod';

import {
  runtimeCapabilityRequirements,
  type DatabaseAdapterKind,
  type RuntimeProfile,
} from '@/platform/runtime/runtime-profile';

import {
  DATABASE_TLS_POLICIES,
  resolveDatabaseTlsPolicy,
  type DatabaseTlsPolicy,
} from './database-tls';
import { baseEnvSchema, parseEnv } from './env-schema';
import { assertDatabaseUrlTls } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const DATABASE_DRIVERS = ['node-pg', 'neon-http', 'neon-websocket'] as const;

export type DatabaseDriver = (typeof DATABASE_DRIVERS)[number];
export type MigrationDatabaseDriver = Exclude<DatabaseDriver, 'neon-http'>;

const databaseEnvSchema = baseEnvSchema.extend({
  DATABASE_URL: z.url(),
  DATABASE_DRIVER: z.enum(DATABASE_DRIVERS).default('node-pg'),
  DATABASE_TLS_POLICY: z.enum(DATABASE_TLS_POLICIES).optional(),
  DATABASE_MIGRATION_URL: z.url().optional(),
  DATABASE_MIGRATION_DRIVER: z.enum(DATABASE_DRIVERS).optional(),
  DATABASE_MIGRATION_TLS_POLICY: z.enum(DATABASE_TLS_POLICIES).optional(),
});

export type DatabaseConfig = {
  databaseUrl: string;
  driver: DatabaseDriver;
  tlsPolicy: DatabaseTlsPolicy;
};

export type MigrationDatabaseConfig = {
  databaseUrl: string;
  driver: MigrationDatabaseDriver;
  tlsPolicy: DatabaseTlsPolicy;
};

const DATABASE_DRIVER_ADAPTER_KINDS = {
  'neon-http': 'postgres-fetch',
  'neon-websocket': undefined,
  'node-pg': 'postgres-node',
} as const satisfies Readonly<
  Record<DatabaseDriver, DatabaseAdapterKind | undefined>
>;

export function assertDatabaseDriverForRuntimeProfile(
  runtimeProfile: Exclude<RuntimeProfile, 'cloudflare'>,
  config: Pick<DatabaseConfig, 'driver'>
): void {
  const requiredAdapter =
    runtimeCapabilityRequirements[runtimeProfile].database;
  const configuredAdapter = DATABASE_DRIVER_ADAPTER_KINDS[config.driver];
  if (configuredAdapter !== requiredAdapter) {
    throw new ConfigurationError(
      `The ${runtimeProfile} runtime profile requires the ${requiredAdapter} request database adapter; DATABASE_DRIVER=${config.driver} does not provide it. Runtime database adapters are selected by the trusted entrypoint, not by deployment autodetection.`
    );
  }
}

let cachedDatabaseConfig: DatabaseConfig | undefined;
let cachedMigrationDatabaseConfig: MigrationDatabaseConfig | undefined;

function getDefaultMigrationDriver(
  runtimeDriver: DatabaseDriver
): MigrationDatabaseDriver {
  return runtimeDriver === 'node-pg' ? 'node-pg' : 'neon-websocket';
}

function assertMigrationDriver(
  driver: DatabaseDriver
): asserts driver is MigrationDatabaseDriver {
  if (driver === 'neon-http') {
    throw new ConfigurationError(
      'DATABASE_MIGRATION_DRIVER=neon-http is not supported because Neon HTTP migrations are not transactional. Use node-pg or neon-websocket.'
    );
  }
}

export function getDatabaseConfig(): DatabaseConfig {
  if (cachedDatabaseConfig) return cachedDatabaseConfig;

  const env = parseEnv(databaseEnvSchema);
  const tlsPolicy = resolveDatabaseTlsPolicy({
    configuredPolicy: env.DATABASE_TLS_POLICY,
    policySourceName: 'DATABASE_TLS_POLICY',
    url: env.DATABASE_URL,
  });
  assertDatabaseUrlTls({
    name: 'DATABASE_URL',
    url: env.DATABASE_URL,
    driver: env.DATABASE_DRIVER,
    env,
    policy: tlsPolicy,
    policyOverrideName: 'DATABASE_TLS_POLICY',
    policySourceName: 'DATABASE_TLS_POLICY',
  });
  cachedDatabaseConfig = {
    databaseUrl: env.DATABASE_URL,
    driver: env.DATABASE_DRIVER,
    tlsPolicy,
  };
  return cachedDatabaseConfig;
}

export function isLikelyTransactionPooledDatabaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname.includes('pooler') ||
      parsed.searchParams.get('pgbouncer') === 'true' ||
      parsed.searchParams.get('pool_mode') === 'transaction'
    );
  } catch {
    return false;
  }
}

function assertMigrationUrlSupportsMigrations(
  databaseUrl: string,
  databaseUrlName: 'DATABASE_MIGRATION_URL' | 'DATABASE_URL'
): void {
  if (!isLikelyTransactionPooledDatabaseUrl(databaseUrl)) return;

  if (databaseUrlName === 'DATABASE_URL') {
    throw new ConfigurationError(
      'DATABASE_URL is transaction-pooled and cannot be used for migrations; set DATABASE_MIGRATION_URL to a direct or session-sticky PostgreSQL endpoint.'
    );
  }

  throw new ConfigurationError(
    'DATABASE_MIGRATION_URL must use a direct or session-sticky PostgreSQL connection. Transaction-pooler URLs are not safe for migrations.'
  );
}

export function getMigrationDatabaseConfig(): MigrationDatabaseConfig {
  if (cachedMigrationDatabaseConfig) return cachedMigrationDatabaseConfig;

  const env = parseEnv(databaseEnvSchema);
  const driver =
    env.DATABASE_MIGRATION_DRIVER ??
    getDefaultMigrationDriver(env.DATABASE_DRIVER);
  assertMigrationDriver(driver);

  const databaseUrl = env.DATABASE_MIGRATION_URL ?? env.DATABASE_URL;
  const databaseUrlName = env.DATABASE_MIGRATION_URL
    ? 'DATABASE_MIGRATION_URL'
    : 'DATABASE_URL';
  const tlsPolicySourceName =
    env.DATABASE_TLS_POLICY !== undefined &&
    env.DATABASE_MIGRATION_TLS_POLICY === undefined
      ? 'DATABASE_TLS_POLICY'
      : 'DATABASE_MIGRATION_TLS_POLICY';
  const tlsPolicy = resolveDatabaseTlsPolicy({
    configuredPolicy:
      env.DATABASE_MIGRATION_TLS_POLICY ?? env.DATABASE_TLS_POLICY,
    policySourceName: tlsPolicySourceName,
    url: databaseUrl,
  });
  assertDatabaseUrlTls({
    name: databaseUrlName,
    url: databaseUrl,
    driver,
    env,
    policy: tlsPolicy,
    policyOverrideName: 'DATABASE_MIGRATION_TLS_POLICY',
    policySourceName: tlsPolicySourceName,
  });
  assertMigrationUrlSupportsMigrations(databaseUrl, databaseUrlName);

  cachedMigrationDatabaseConfig = {
    databaseUrl,
    driver,
    tlsPolicy,
  };
  return cachedMigrationDatabaseConfig;
}
