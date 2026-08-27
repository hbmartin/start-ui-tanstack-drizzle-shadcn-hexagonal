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

const DATABASE_URL_POLICY_NAMES = {
  DATABASE_MIGRATION_URL: 'DATABASE_MIGRATION_TLS_POLICY',
  DATABASE_URL: 'DATABASE_TLS_POLICY',
} as const;

export const MIGRATION_DATABASE_CLIENT_URL_NAME =
  'migration database client URL' as const;

type MigrationDatabaseUrlSubject =
  | keyof typeof DATABASE_URL_POLICY_NAMES
  | typeof MIGRATION_DATABASE_CLIENT_URL_NAME;

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

export function assertMigrationDriver(
  driver: unknown
): asserts driver is MigrationDatabaseDriver {
  if (driver === 'node-pg' || driver === 'neon-websocket') return;

  if (driver === 'neon-http') {
    throw new ConfigurationError(
      'DATABASE_MIGRATION_DRIVER=neon-http is not supported because Neon HTTP migrations are not transactional. Use node-pg or neon-websocket.'
    );
  }

  throw new ConfigurationError(
    'DATABASE_MIGRATION_DRIVER must be node-pg or neon-websocket.'
  );
}

export function getDatabaseConfig(): DatabaseConfig {
  if (cachedDatabaseConfig) return cachedDatabaseConfig;

  const env = parseEnv(databaseEnvSchema);
  const tlsPolicy = resolveDatabaseTlsPolicy({
    configuredPolicy: env.DATABASE_TLS_POLICY,
    policyOverrideName: 'DATABASE_TLS_POLICY',
    policySourceName: 'DATABASE_TLS_POLICY',
    urlName: 'DATABASE_URL',
    url: env.DATABASE_URL,
  });
  assertDatabaseUrlTls({
    name: 'DATABASE_URL',
    url: env.DATABASE_URL,
    driver: env.DATABASE_DRIVER,
    env,
    policy: tlsPolicy,
    policyOverrideName: 'DATABASE_TLS_POLICY',
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
    const hasTransactionPoolerParameter = [...parsed.searchParams].some(
      isTransactionPoolerParameter
    );
    return (
      parsed.hostname.toLowerCase().includes('pooler') ||
      hasTransactionPoolerParameter
    );
  } catch {
    return false;
  }
}

function isTransactionPoolerParameter([parameterName, parameterValue]: [
  string,
  string,
]): boolean {
  const normalizedName = parameterName.trim().toLowerCase();
  const normalizedValue = parameterValue.trim().toLowerCase();
  return (
    (normalizedName === 'pgbouncer' && normalizedValue === 'true') ||
    (normalizedName === 'pool_mode' && normalizedValue === 'transaction')
  );
}

export function assertMigrationUrlSupportsMigrations(
  databaseUrl: string,
  databaseUrlName: MigrationDatabaseUrlSubject = MIGRATION_DATABASE_CLIENT_URL_NAME
): void {
  if (!isLikelyTransactionPooledDatabaseUrl(databaseUrl)) return;

  if (databaseUrlName === 'DATABASE_URL') {
    throw new ConfigurationError(
      'DATABASE_URL is transaction-pooled and cannot be used for migrations; set DATABASE_MIGRATION_URL to a direct or session-sticky PostgreSQL endpoint.'
    );
  }

  if (databaseUrlName === 'DATABASE_MIGRATION_URL') {
    throw new ConfigurationError(
      'DATABASE_MIGRATION_URL must use a direct or session-sticky PostgreSQL connection. Transaction-pooler URLs are not safe for migrations.'
    );
  }

  throw new ConfigurationError(
    `${databaseUrlName} must use a direct or session-sticky PostgreSQL connection. Transaction-pooler URLs are not safe for migrations.`
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
    env.DATABASE_MIGRATION_TLS_POLICY !== undefined
      ? 'DATABASE_MIGRATION_TLS_POLICY'
      : env.DATABASE_TLS_POLICY !== undefined
        ? 'DATABASE_TLS_POLICY'
        : undefined;
  const tlsPolicyOverrideName =
    env.DATABASE_MIGRATION_TLS_POLICY !== undefined ||
    databaseUrlName === 'DATABASE_MIGRATION_URL'
      ? 'DATABASE_MIGRATION_TLS_POLICY'
      : 'DATABASE_TLS_POLICY';
  const urlOwnerPolicyName = DATABASE_URL_POLICY_NAMES[databaseUrlName];
  const tlsPolicy = resolveDatabaseTlsPolicy({
    configuredPolicy:
      env.DATABASE_MIGRATION_TLS_POLICY ?? env.DATABASE_TLS_POLICY,
    policyOverrideName: tlsPolicyOverrideName,
    policySourceName: tlsPolicySourceName,
    urlName: databaseUrlName,
    url: databaseUrl,
  });
  assertDatabaseUrlTls({
    name: databaseUrlName,
    url: databaseUrl,
    driver,
    env,
    policy: tlsPolicy,
    policyOverrideName: tlsPolicyOverrideName,
    urlOwnerPolicyName,
  });
  assertMigrationUrlSupportsMigrations(databaseUrl, databaseUrlName);

  cachedMigrationDatabaseConfig = {
    databaseUrl,
    driver,
    tlsPolicy,
  };
  return cachedMigrationDatabaseConfig;
}
