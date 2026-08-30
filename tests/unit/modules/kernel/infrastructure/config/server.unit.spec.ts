import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  assertDatabaseDriverForRuntimeProfile: vi.fn(),
  getEnvClient: vi.fn(),
  getTelemetryConfig: vi.fn(),
  getDatabaseConfig: vi.fn(() => ({ driver: 'node-pg' })),
  production: true,
  skipEnvValidation: false,
  telemetry: {
    collectorUrl: undefined as string | undefined,
    dsn: undefined as string | undefined,
    mode: 'optional' as 'off' | 'optional' | 'required',
    requiredSignals: [] as Array<'exceptions' | 'logs' | 'metrics' | 'traces'>,
  },
  trustedProxyDepth: undefined as number | undefined,
}));

vi.mock('@/platform/env/client', () => ({
  getEnvClient: configMock.getEnvClient,
}));

vi.mock('@/modules/kernel/infrastructure/config/application', () => ({
  getApplicationConfig: () => ({ preset: 'core' }),
}));
vi.mock('@/modules/kernel/infrastructure/config/auth', () => ({
  getAuthConfig: vi.fn(),
}));
vi.mock('@/modules/kernel/infrastructure/config/database', () => ({
  assertDatabaseDriverForRuntimeProfile:
    configMock.assertDatabaseDriverForRuntimeProfile,
  getDatabaseConfig: configMock.getDatabaseConfig,
}));
vi.mock('@/modules/kernel/infrastructure/config/email', () => ({
  getEmailConfig: vi.fn(),
}));
vi.mock('@/modules/kernel/infrastructure/config/env-schema', () => ({
  isProdRuntimeEnvironment: () => configMock.production,
  shouldSkipEnvValidation: () => configMock.skipEnvValidation,
}));
vi.mock('@/modules/kernel/infrastructure/config/http', () => ({
  getHttpConfig: () => ({
    trustedProxyDepth: configMock.trustedProxyDepth,
  }),
}));
vi.mock('@/modules/kernel/infrastructure/config/logger', () => ({
  getLoggerConfig: vi.fn(),
}));
vi.mock('@/modules/kernel/infrastructure/config/redis', () => ({
  getRedisConfig: vi.fn(),
}));
vi.mock('@/modules/kernel/infrastructure/config/storage', () => ({
  getStorageConfig: vi.fn(),
}));
vi.mock('@/modules/kernel/infrastructure/config/telemetry', () => ({
  getTelemetryConfig: configMock.getTelemetryConfig,
}));

describe('runtime-profile server configuration', () => {
  beforeEach(() => {
    configMock.getEnvClient.mockClear();
    configMock.assertDatabaseDriverForRuntimeProfile.mockClear();
    configMock.getDatabaseConfig.mockClear();
    configMock.getTelemetryConfig.mockReset();
    configMock.getTelemetryConfig.mockImplementation(
      () => configMock.telemetry
    );
    configMock.production = true;
    configMock.skipEnvValidation = false;
    configMock.telemetry.collectorUrl = undefined;
    configMock.telemetry.dsn = undefined;
    configMock.telemetry.mode = 'optional';
    configMock.telemetry.requiredSignals = [];
    configMock.trustedProxyDepth = undefined;
  });

  it.each(['vercel'] as const)(
    'does not require Node proxy depth for the %s profile',
    async (runtimeProfile) => {
      const { validateServerConfig } =
        await import('@/modules/kernel/infrastructure/config/server');

      expect(() => validateServerConfig(runtimeProfile)).not.toThrow();
      expect(configMock.getEnvClient).toHaveBeenCalledWith(runtimeProfile);
      expect(
        configMock.assertDatabaseDriverForRuntimeProfile
      ).toHaveBeenCalledWith(runtimeProfile, { driver: 'node-pg' });
    }
  );

  it('allows Cloudflare artifact validation before the live Hyperdrive adapter is installed', async () => {
    const { validateServerBuildConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerBuildConfig('cloudflare')).not.toThrow();
    expect(
      configMock.assertDatabaseDriverForRuntimeProfile
    ).not.toHaveBeenCalled();
    expect(configMock.getDatabaseConfig).not.toHaveBeenCalled();
  });

  it('requires the exact Cloudflare live database adapter', async () => {
    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig('cloudflare')).toThrow(
      'hyperdrive database adapter'
    );
    expect(() =>
      validateServerConfig('cloudflare', {
        databaseAdapter: 'postgres-node',
      })
    ).toThrow('hyperdrive database adapter');
    expect(() =>
      validateServerConfig('cloudflare', {
        databaseAdapter: 'hyperdrive',
      })
    ).not.toThrow();
    expect(
      configMock.assertDatabaseDriverForRuntimeProfile
    ).not.toHaveBeenCalled();
    expect(configMock.getDatabaseConfig).not.toHaveBeenCalled();
  });

  it('does not let skipped environment parsing bypass the Cloudflare adapter', async () => {
    configMock.skipEnvValidation = true;
    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig('cloudflare')).toThrow(
      'hyperdrive database adapter'
    );
    expect(() =>
      validateServerConfig('cloudflare', { databaseAdapter: 'hyperdrive' })
    ).not.toThrow();
    expect(
      configMock.assertDatabaseDriverForRuntimeProfile
    ).not.toHaveBeenCalled();
    expect(configMock.getDatabaseConfig).not.toHaveBeenCalled();
    expect(configMock.getTelemetryConfig).not.toHaveBeenCalled();
  });

  it('requires a positive Node proxy depth in production', async () => {
    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig('node')).toThrow('positive integer');
    configMock.trustedProxyDepth = 0;
    expect(() => validateServerConfig('node')).toThrow('positive integer');
    configMock.trustedProxyDepth = 1;
    expect(() => validateServerConfig('node')).not.toThrow();
    expect(configMock.getEnvClient).toHaveBeenLastCalledWith('node');
    expect(
      configMock.assertDatabaseDriverForRuntimeProfile
    ).toHaveBeenCalledWith('node', { driver: 'node-pg' });
  });

  it('fails Node live validation when a required OTel signal lacks a collector', async () => {
    configMock.production = false;
    configMock.telemetry.mode = 'required';
    configMock.telemetry.requiredSignals = ['traces'];
    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');
    const { validateServerBuildConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerBuildConfig('node')).not.toThrow();
    expect(() => validateServerConfig('node')).toThrow(
      'node during configuration: traces'
    );
    configMock.telemetry.collectorUrl = 'https://collector.example.test';
    expect(() => validateServerConfig('node')).not.toThrow();
  });

  it('keeps Vercel trace readiness independent of collector configuration', async () => {
    configMock.telemetry.mode = 'required';
    configMock.telemetry.requiredSignals = ['traces'];
    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig('vercel')).not.toThrow();
  });

  it('requires exception configuration for live profile validation', async () => {
    configMock.production = false;
    configMock.telemetry.mode = 'required';
    configMock.telemetry.requiredSignals = ['exceptions'];
    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');
    const { validateServerBuildConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerBuildConfig('node')).not.toThrow();
    expect(() => validateServerConfig('node')).toThrow('exceptions');
    configMock.telemetry.dsn = 'https://public@example.test/1';
    expect(() => validateServerConfig('node')).not.toThrow();
  });
});
