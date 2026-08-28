import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  removeRuntimeArtifactOutput,
  runtimeArtifactOutputDirectory,
} from '../../../scripts/runtime-artifact-output.mjs';
import {
  createArtifactBuildEnvironment,
  createArtifactVerificationEnvironment,
  createCloudflareArtifactProvenanceKey,
  parseArtifactProfile,
  removeVerifiedCloudflareProvenance,
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

  it.each([
    ['node', 'node-pg', 'off'],
    ['vercel', 'neon-http', 'verify'],
  ])(
    'selects the %s artifact database fixture %s with TLS %s',
    (profile, driver, tlsPolicy) => {
      const environment = createArtifactVerificationEnvironment(profile);

      expect(environment.DATABASE_DRIVER).toBe(driver);
      expect(environment.DATABASE_TLS_POLICY).toBe(tlsPolicy);
      expect(environment.DATABASE_MIGRATION_DRIVER).toBe('node-pg');
      expect(environment.DATABASE_MIGRATION_TLS_POLICY).toBe('off');
    }
  );

  it('does not invent a process database adapter for a Cloudflare artifact', () => {
    const environment = createArtifactVerificationEnvironment('cloudflare');

    expect(environment.DATABASE_URL).toBeUndefined();
    expect(environment.DATABASE_DRIVER).toBeUndefined();
    expect(environment.DATABASE_TLS_POLICY).toBeUndefined();
    expect(environment.DATABASE_MIGRATION_URL).toBeUndefined();
    expect(environment.DATABASE_MIGRATION_DRIVER).toBeUndefined();
    expect(environment.DATABASE_MIGRATION_TLS_POLICY).toBeUndefined();
  });

  it('scopes an ephemeral provenance key to the Cloudflare Vite build', () => {
    const key = createCloudflareArtifactProvenanceKey();
    const base = { NODE_ENV: 'production' };
    const cloudflare = createArtifactBuildEnvironment('cloudflare', base, key);

    expect(Buffer.from(key, 'base64url')).toHaveLength(32);
    expect(cloudflare).toEqual({
      ...base,
      START_UI_CLOUDFLARE_PROVENANCE_KEY: key,
    });
    expect(createArtifactBuildEnvironment('node', base, undefined)).toBe(base);
    expect(base).not.toHaveProperty('START_UI_CLOUDFLARE_PROVENANCE_KEY');
  });

  it('removes only the authenticated Cloudflare provenance after verification', () => {
    const repository = createTemporaryRepository();
    const provenance = path.join(
      repository,
      'dist/server/start-ui-app-chunk-provenance.json'
    );
    const serverEntry = path.join(repository, 'dist/server/index.js');
    fs.mkdirSync(path.dirname(provenance), { recursive: true });
    fs.writeFileSync(provenance, '{"signature":"ephemeral"}');
    fs.writeFileSync(serverEntry, 'export default {};');

    removeVerifiedCloudflareProvenance('cloudflare', repository);

    expect(fs.existsSync(provenance)).toBe(false);
    expect(fs.existsSync(serverEntry)).toBe(true);
    removeVerifiedCloudflareProvenance('node', repository);
    expect(fs.existsSync(serverEntry)).toBe(true);
  });

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
