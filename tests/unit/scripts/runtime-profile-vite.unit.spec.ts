import { describe, expect, it } from 'vitest';

import {
  cloudflareVitePluginOptions,
  createCanonicalOriginVitePlugin,
  createRuntimeServerEntrySource,
  resolveViteRuntimeProfile,
  runtimeServerEntryPaths,
  shouldInstallNodeNitroFatalOwner,
} from '../../../scripts/runtime-profile-vite';

describe('runtime profile Vite selection', () => {
  it('keeps Cloudflare builds local and source-configured', () => {
    expect(cloudflareVitePluginOptions).toEqual({
      configPath: './wrangler.json',
      remoteBindings: false,
      viteEnvironment: { name: 'ssr' },
    });
  });

  it('fails closed for builds without an explicit profile', () => {
    expect(() =>
      resolveViteRuntimeProfile({ command: 'build' }, undefined)
    ).toThrow(/pnpm build:node/);
    expect(() =>
      resolveViteRuntimeProfile({ command: 'build' }, 'auto')
    ).toThrow(/must be one of/);
  });

  it('uses Node only as the local serve default', () => {
    expect(resolveViteRuntimeProfile({ command: 'serve' }, undefined)).toBe(
      'node'
    );
  });

  it('installs fatal ownership only for production Node builds', () => {
    expect(shouldInstallNodeNitroFatalOwner({ command: 'build' }, 'node')).toBe(
      true
    );
    expect(shouldInstallNodeNitroFatalOwner({ command: 'serve' }, 'node')).toBe(
      false
    );
    expect(
      shouldInstallNodeNitroFatalOwner({ command: 'build' }, 'vercel')
    ).toBe(false);
  });

  it('replaces a divergent Vite client origin with the canonical origin', () => {
    const plugin = createCanonicalOriginVitePlugin(
      'https://canonical.example.test'
    );
    const config = {
      env: { VITE_BASE_URL: 'https://hostile-build-value.invalid' },
    };
    const hook = plugin.configResolved as (config: never) => void;
    expect(typeof hook).toBe('function');

    hook(config as never);

    expect(config.env.VITE_BASE_URL).toBe('https://canonical.example.test');
  });

  it.each([
    ['node', ['vercel', 'cloudflare']],
    ['vercel', ['node', 'cloudflare']],
    ['cloudflare', ['node', 'vercel']],
  ] as const)(
    'selects only the %s entry from the trusted build input',
    (profile, otherProfiles) => {
      expect(resolveViteRuntimeProfile({ command: 'build' }, profile)).toBe(
        profile
      );
      const source = createRuntimeServerEntrySource({
        profile,
        root: '/workspace',
      });
      expect(source).toContain(runtimeServerEntryPaths[profile]);
      for (const otherProfile of otherProfiles) {
        expect(source).not.toContain(runtimeServerEntryPaths[otherProfile]);
      }
    }
  );
});
