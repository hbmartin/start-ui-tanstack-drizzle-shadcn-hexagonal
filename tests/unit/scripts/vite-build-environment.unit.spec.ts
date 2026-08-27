import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadViteBuildEnvironment } from '../../../scripts/vite-build-environment';

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('loadViteBuildEnvironment', () => {
  it('does not load hostile local env files for an isolated build', () => {
    vi.stubEnv('APP_DOMAIN', undefined);
    vi.stubEnv('VITE_S3_BUCKET_PUBLIC_URL', undefined);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-vite-env-'));
    temporaryDirectories.push(root);
    fs.writeFileSync(
      path.join(root, '.env.production.local'),
      [
        'VITE_HOSTILE_LOCAL_SENTINEL=must-not-enter-build',
        'VITE_S3_BUCKET_PUBLIC_URL=https://hostile.example.test',
        'APP_DOMAIN=https://hostile-origin.example.test',
      ].join('\n')
    );

    const isolated = loadViteBuildEnvironment({
      isolated: true,
      mode: 'production',
      root,
    });
    const ordinary = loadViteBuildEnvironment({
      isolated: false,
      mode: 'production',
      root,
    });

    expect(isolated.envDir).toBe(false);
    expect(isolated.env.VITE_HOSTILE_LOCAL_SENTINEL).toBeUndefined();
    expect(isolated.env.VITE_S3_BUCKET_PUBLIC_URL).toBeUndefined();
    expect(isolated.env.APP_DOMAIN).toBeUndefined();
    expect(ordinary.env.VITE_HOSTILE_LOCAL_SENTINEL).toBe(
      'must-not-enter-build'
    );
    expect(ordinary.env.APP_DOMAIN).toBe('https://hostile-origin.example.test');
  });
});
