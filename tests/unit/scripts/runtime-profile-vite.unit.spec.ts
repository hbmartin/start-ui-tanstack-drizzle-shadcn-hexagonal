import { describe, expect, it } from 'vitest';

import {
  cloudflareVitePluginOptions,
  createRuntimeServerEntrySource,
  resolveViteRuntimeProfile,
  runtimeServerEntryPaths,
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
