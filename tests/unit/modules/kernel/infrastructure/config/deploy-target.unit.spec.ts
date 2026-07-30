import { beforeEach, describe, expect, it, vi } from 'vitest';

const loadConfig = () =>
  import('@/modules/kernel/infrastructure/config/deploy-target');

describe('deploy target config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('SKIP_ENV_VALIDATION', undefined);
  });

  it('uses an explicit DEPLOY_TARGET, normalized to lowercase', async () => {
    vi.stubEnv('DEPLOY_TARGET', ' Staging ');
    const { getDeployTargetConfig } = await loadConfig();

    expect(getDeployTargetConfig()).toEqual({ deployTarget: 'staging' });
  });

  it('caches the parsed config', async () => {
    vi.stubEnv('DEPLOY_TARGET', 'staging');
    const { getDeployTargetConfig } = await loadConfig();

    const first = getDeployTargetConfig();
    vi.stubEnv('DEPLOY_TARGET', 'production');

    expect(getDeployTargetConfig()).toBe(first);
  });

  it('rejects DEPLOY_TARGET values outside the tag-safe alphabet', async () => {
    vi.stubEnv('DEPLOY_TARGET', 'my target!');
    const { getDeployTargetConfig } = await loadConfig();
    const { ConfigurationError } =
      await import('@/modules/kernel/domain/errors/configuration-error');

    expect(() => getDeployTargetConfig()).toThrow(ConfigurationError);
  });

  it('derives production for production runtimes', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const { getDeployTargetConfig } = await loadConfig();

    expect(getDeployTargetConfig()).toEqual({ deployTarget: 'production' });
  });

  it('derives a slug from VITE_ENV_NAME for non-production runtimes', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VITE_ENV_NAME', 'Preview 42');
    const { getDeployTargetConfig } = await loadConfig();

    expect(getDeployTargetConfig()).toEqual({ deployTarget: 'preview-42' });
  });

  it('falls back to local when nothing identifies the environment', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VITE_ENV_NAME', undefined);
    const { getDeployTargetConfig } = await loadConfig();

    expect(getDeployTargetConfig()).toEqual({ deployTarget: 'local' });
  });

  it('falls back to local when VITE_ENV_NAME has no tag-safe characters', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('VITE_ENV_NAME', '🚧');
    const { getDeployTargetConfig } = await loadConfig();

    expect(getDeployTargetConfig()).toEqual({ deployTarget: 'local' });
  });
});
