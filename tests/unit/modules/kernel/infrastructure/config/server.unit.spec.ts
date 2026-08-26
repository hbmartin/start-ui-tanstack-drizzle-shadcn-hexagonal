import { beforeEach, describe, expect, it, vi } from 'vitest';

const configMock = vi.hoisted(() => ({
  production: true,
  trustedProxyDepth: undefined as number | undefined,
}));

vi.mock('@/modules/kernel/infrastructure/config/application', () => ({
  getApplicationConfig: () => ({ preset: 'core' }),
}));
vi.mock('@/modules/kernel/infrastructure/config/auth', () => ({
  getAuthConfig: vi.fn(),
}));
vi.mock('@/modules/kernel/infrastructure/config/database', () => ({
  getDatabaseConfig: vi.fn(),
}));
vi.mock('@/modules/kernel/infrastructure/config/email', () => ({
  getEmailConfig: vi.fn(),
}));
vi.mock('@/modules/kernel/infrastructure/config/env-schema', () => ({
  isProdRuntimeEnvironment: () => configMock.production,
  shouldSkipEnvValidation: () => false,
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
  getTelemetryConfig: vi.fn(),
}));

describe('runtime-profile server configuration', () => {
  beforeEach(() => {
    configMock.production = true;
    configMock.trustedProxyDepth = undefined;
  });

  it.each(['vercel', 'cloudflare'] as const)(
    'does not require Node proxy depth for the %s profile',
    async (runtimeProfile) => {
      const { validateServerConfig } =
        await import('@/modules/kernel/infrastructure/config/server');

      expect(() => validateServerConfig(runtimeProfile)).not.toThrow();
    }
  );

  it('requires a positive Node proxy depth in production', async () => {
    const { validateServerConfig } =
      await import('@/modules/kernel/infrastructure/config/server');

    expect(() => validateServerConfig('node')).toThrow('positive integer');
    configMock.trustedProxyDepth = 0;
    expect(() => validateServerConfig('node')).toThrow('positive integer');
    configMock.trustedProxyDepth = 1;
    expect(() => validateServerConfig('node')).not.toThrow();
  });
});
