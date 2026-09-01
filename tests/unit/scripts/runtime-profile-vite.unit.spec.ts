import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  cloudflareVitePluginOptions,
  createCloudflareAppChunkProvenance,
  createCloudflareAppChunkProvenanceEnvelope,
  createCloudflareAppChunkProvenancePlugin,
  createCanonicalOriginVitePlugin,
  createTelemetryModeVitePlugin,
  createRuntimeServerEntrySource,
  isPathWithinDirectory,
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

  it('derives app-only chunk provenance from every resolved module ID', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-vite-'));
    try {
      const appModule = path.join(root, 'src/app.ts');
      const packageModule = path.join(root, 'node_modules/pkg/index.js');
      fs.mkdirSync(path.dirname(appModule), { recursive: true });
      fs.mkdirSync(path.dirname(packageModule), { recursive: true });
      fs.writeFileSync(appModule, 'export const app = true;');
      fs.writeFileSync(packageModule, 'export const dependency = true;');
      const appCode = 'const app=true;';
      const mixedCode = '//#region src/app.ts\nconst mixed=true;';

      const provenance = createCloudflareAppChunkProvenance(root, {
        'assets/app.js': {
          code: appCode,
          dynamicImports: [
            'assets/z-last.js',
            'assets/mixed.js',
            'cloudflare:sockets',
          ],
          fileName: 'assets/app.js',
          imports: ['assets/virtual.js', 'assets/a-first.js', 'node:crypto'],
          modules: { [appModule]: {} },
          type: 'chunk',
        },
        'assets/a-first.js': {
          code: 'const first=true;',
          fileName: 'assets/a-first.js',
          modules: { '\0virtual:first': {} },
          type: 'chunk',
        },
        'assets/mixed.js': {
          code: mixedCode,
          fileName: 'assets/mixed.js',
          modules: { [appModule]: {}, [packageModule]: {} },
          type: 'chunk',
        },
        'assets/virtual.js': {
          code: 'const virtual=true;',
          fileName: 'assets/virtual.js',
          modules: { '\0virtual:helper': {} },
          type: 'chunk',
        },
        'assets/z-last.js': {
          code: 'const last=true;',
          fileName: 'assets/z-last.js',
          modules: { '\0virtual:last': {} },
          type: 'chunk',
        },
      });

      expect(provenance.chunks['assets/app.js']).toEqual({
        dynamicImports: ['assets/mixed.js', 'assets/z-last.js'],
        imports: ['assets/a-first.js', 'assets/virtual.js'],
        modules: [{ id: 'src/app.ts', owner: 'app' }],
        ownership: 'app-only',
        sha256: createHash('sha256').update(appCode).digest('hex'),
      });
      expect(provenance.chunks['assets/mixed.js']?.ownership).toBe('mixed');
      expect(provenance.chunks['assets/mixed.js']?.modules).toEqual([
        { id: 'node_modules/pkg/index.js', owner: 'non-app' },
        { id: 'src/app.ts', owner: 'app' },
      ]);
      expect(provenance.chunks['assets/virtual.js']?.ownership).toBe('non-app');
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('preserves Vite query identities and rejects a source symlink escape', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-vite-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-outside-'));
    try {
      const appModule = path.join(root, 'src/app.svg');
      const outsideModule = path.join(outside, 'escape.ts');
      const linkedModule = path.join(root, 'src/escape.ts');
      fs.mkdirSync(path.dirname(appModule), { recursive: true });
      fs.writeFileSync(appModule, '<svg/>');
      fs.writeFileSync(outsideModule, 'export const escaped = true;');
      fs.symlinkSync(outsideModule, linkedModule);

      const provenance = createCloudflareAppChunkProvenance(root, {
        'assets/queries.js': {
          code: 'const values=[];',
          fileName: 'assets/queries.js',
          modules: {
            [`${appModule}?raw`]: {},
            [`${appModule}?url`]: {},
          },
          type: 'chunk',
        },
        'assets/symlink.js': {
          code: 'const escaped=true;',
          fileName: 'assets/symlink.js',
          modules: { [linkedModule]: {} },
          type: 'chunk',
        },
      });

      expect(provenance.chunks['assets/queries.js']?.modules).toEqual([
        { id: 'src/app.svg?raw', owner: 'app' },
        { id: 'src/app.svg?url', owner: 'app' },
      ]);
      expect(provenance.chunks['assets/queries.js']?.ownership).toBe(
        'app-only'
      );
      expect(provenance.chunks['assets/symlink.js']?.ownership).toBe('non-app');
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
      fs.rmSync(outside, { force: true, recursive: true });
    }
  });

  it('does not promote an outside lexical module symlinked into src', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-vite-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-outside-'));
    try {
      const appModule = path.join(root, 'src/app.ts');
      const outsideAlias = path.join(outside, 'app-alias.ts');
      fs.mkdirSync(path.dirname(appModule), { recursive: true });
      fs.writeFileSync(appModule, 'export const app = true;');
      fs.symlinkSync(appModule, outsideAlias);

      const provenance = createCloudflareAppChunkProvenance(root, {
        'assets/outside-alias.js': {
          code: 'const app=true;',
          fileName: 'assets/outside-alias.js',
          modules: { [outsideAlias]: {} },
          type: 'chunk',
        },
      });

      const chunk = provenance.chunks['assets/outside-alias.js']!;
      const [module] = chunk.modules;
      expect(module?.owner).toBe('non-app');
      expect(module?.id).toMatch(/^non-app:[a-f\d]{64}$/u);
      expect(module?.id).not.toContain(outside);
      expect(chunk.ownership).toBe('non-app');
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
      fs.rmSync(outside, { force: true, recursive: true });
    }
  });

  it('keeps virtual identities collision-resistant and path-opaque', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-vite-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      const missing = path.join(root, 'generated/missing.ts');
      const provenance = createCloudflareAppChunkProvenance(root, {
        'assets/virtual.js': {
          code: 'const values=[];',
          fileName: 'assets/virtual.js',
          modules: {
            '\0foo': {},
            '<virtual>foo': {},
            [missing]: {},
          },
          type: 'chunk',
        },
      });
      const modules = provenance.chunks['assets/virtual.js']!.modules;

      expect(new Set(modules.map(({ id }) => id)).size).toBe(3);
      expect(modules.every(({ id }) => /^non-app:[a-f\d]{64}$/u.test(id))).toBe(
        true
      );
      expect(JSON.stringify(modules)).not.toContain(root);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('authenticates fresh-build provenance without persisting its key', () => {
    const key = Buffer.alloc(32, 9).toString('base64url');
    const provenance = { chunks: {}, version: 1 } as const;
    const envelope = createCloudflareAppChunkProvenanceEnvelope(
      provenance,
      key
    );

    expect(envelope.algorithm).toBe('hmac-sha256');
    expect(envelope).not.toHaveProperty('key');
    expect(envelope.signature).toBe(
      createHmac('sha256', Buffer.from(key, 'base64url'))
        .update(envelope.payload)
        .digest('base64url')
    );
    expect(
      createCloudflareAppChunkProvenanceEnvelope(provenance).algorithm
    ).toBe('none');
  });

  it('emits provenance only for an authenticated verification build', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-vite-'));
    try {
      fs.mkdirSync(path.join(root, 'src'), { recursive: true });
      const emitted: unknown[] = [];
      const invoke = (key?: string) => {
        const plugin = createCloudflareAppChunkProvenancePlugin(root, key);
        const hook = plugin.generateBundle as unknown as (
          this: { emitFile: (asset: unknown) => void },
          options: unknown,
          bundle: Readonly<Record<string, unknown>>
        ) => void;
        hook.call({ emitFile: (asset) => emitted.push(asset) }, {}, {});
      };

      invoke();
      expect(emitted).toEqual([]);
      invoke(Buffer.alloc(32, 7).toString('base64url'));
      expect(emitted).toHaveLength(1);
    } finally {
      fs.rmSync(root, { force: true, recursive: true });
    }
  });

  it('rejects Windows cross-drive paths from a directory boundary', () => {
    expect(
      isPathWithinDirectory(
        'D:\\artifact\\chunk.js',
        'C:\\artifact',
        path.win32
      )
    ).toBe(false);
    expect(
      isPathWithinDirectory(
        'C:\\artifact\\assets\\chunk.js',
        'C:\\artifact',
        path.win32
      )
    ).toBe(true);
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

  it('projects exactly one validated telemetry mode into the client env', () => {
    const plugin = createTelemetryModeVitePlugin('off');
    const config = { env: {} as Record<string, string> };
    const hook = plugin.configResolved as (config: never) => void;

    hook(config as never);

    expect(config.env).toEqual({ TELEMETRY_MODE: 'off' });
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
