import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  removeRuntimeArtifactOutput,
  runtimeArtifactOutputDirectory,
} from '../../../scripts/runtime-artifact-output.mjs';
import {
  createArtifactVerificationEnvironment,
  parseArtifactProfile,
} from '../../../scripts/verify-runtime-artifact-build.mjs';

const temporaryDirectories = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

const createTemporaryRepository = () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'start-ui-runtime-artifact-')
  );
  temporaryDirectories.push(directory);
  return directory;
};

describe('runtime artifact build verification', () => {
  it.each(['node', 'vercel', 'cloudflare'])(
    'creates an isolated %s build environment',
    (profile) => {
      const environment = createArtifactVerificationEnvironment(profile);
      expect(environment.START_UI_RUNTIME_PROFILE).toBe(profile);
      expect(environment.START_UI_DISABLE_CLOUD_BUILD_PLUGINS).toBe('true');
      expect(environment.CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV).toBe('false');
      expect(environment.NODE_ENV).toBe('production');
    }
  );

  it('rejects implicit and unknown profiles', () => {
    expect(() => parseArtifactProfile(undefined)).toThrow('unknown profile');
    expect(() => parseArtifactProfile('auto')).toThrow('unknown profile auto');
  });

  it.each([
    ['node', '.output/node'],
    ['vercel', '.vercel/output'],
    ['cloudflare', 'dist'],
  ])('maps %s to its isolated artifact output', (profile, relativeOutput) => {
    const repository = createTemporaryRepository();
    expect(runtimeArtifactOutputDirectory(profile, repository)).toBe(
      path.join(fs.realpathSync.native(repository), relativeOutput)
    );
  });

  it('removes only Vercel build output and preserves project linkage', () => {
    const repository = createTemporaryRepository();
    const projectFile = path.join(repository, '.vercel/project.json');
    const staleArtifact = path.join(repository, '.vercel/output/stale.txt');
    fs.mkdirSync(path.dirname(staleArtifact), { recursive: true });
    fs.writeFileSync(projectFile, '{"projectId":"preserved"}');
    fs.writeFileSync(staleArtifact, 'stale');

    removeRuntimeArtifactOutput('vercel', repository);

    expect(fs.existsSync(staleArtifact)).toBe(false);
    expect(fs.readFileSync(projectFile, 'utf8')).toContain('preserved');
  });

  it('refuses unknown profiles and filesystem roots', () => {
    const repository = createTemporaryRepository();
    expect(() => runtimeArtifactOutputDirectory('unknown', repository)).toThrow(
      'Unknown runtime artifact profile'
    );
    expect(() =>
      runtimeArtifactOutputDirectory('node', path.parse(repository).root)
    ).toThrow('filesystem root');
  });

  it.each([
    ['node', '.output', 'node'],
    ['vercel', '.vercel', 'output'],
  ])(
    'refuses a symlinked %s artifact parent without deleting external files',
    (profile, artifactParent, profileOutput) => {
      const repository = createTemporaryRepository();
      const externalDirectory = createTemporaryRepository();
      const externalArtifact = path.join(
        externalDirectory,
        profileOutput,
        'marker.txt'
      );
      fs.mkdirSync(path.dirname(externalArtifact), { recursive: true });
      fs.writeFileSync(externalArtifact, 'must survive');
      fs.symlinkSync(
        externalDirectory,
        path.join(repository, artifactParent),
        'dir'
      );

      expect(() => removeRuntimeArtifactOutput(profile, repository)).toThrow(
        'symbolic link'
      );
      expect(fs.readFileSync(externalArtifact, 'utf8')).toBe('must survive');
    }
  );
});
