import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  removeRuntimeArtifactOutput,
  runtimeArtifactOutputDirectory,
} from '../../../scripts/runtime-artifact-output.mjs';
import {
  completeArtifactSignalShutdown,
  createArtifactBuildEnvironment,
  createArtifactChildRegistry,
  createArtifactShutdownCoordinator,
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

  it('terminates every active artifact child and rejects later spawns', async () => {
    const registry = createArtifactChildRegistry(10);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn((signal) => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      }),
      signalCode: null,
    });
    const sibling = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn((signal) => {
        sibling.signalCode = signal;
        sibling.emit('exit', null, signal);
      }),
      signalCode: null,
    });
    registry.track(child);
    registry.track(sibling);

    await registry.terminateAll('SIGTERM', { permanent: true });

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(sibling.kill).toHaveBeenCalledWith('SIGTERM');
    expect(registry.size).toBe(0);
    expect(() => registry.assertCanSpawn()).toThrow(
      'shutdown began before child spawn'
    );
  });

  it('escalates an unresponsive artifact child to SIGKILL', async () => {
    const registry = createArtifactChildRegistry(5);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      signalCode: null,
    });
    child.kill
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce((signal) => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
      });
    registry.track(child);

    await registry.terminateAll('SIGTERM');

    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(registry.size).toBe(0);
  });

  it('fails cleanup when an artifact child survives SIGKILL', async () => {
    const registry = createArtifactChildRegistry(1);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      signalCode: null,
    });
    registry.track(child);

    await expect(registry.terminateAll('SIGTERM')).rejects.toThrow(
      'child cleanup was incomplete'
    );

    expect(() => registry.assertCanSpawn()).toThrow(
      'shutdown began before child spawn'
    );
    expect(child.kill.mock.calls).toEqual([['SIGTERM'], ['SIGKILL']]);
    expect(registry.size).toBe(1);
  });

  it('allows permanent shutdown to retry a failed ordinary cleanup', async () => {
    const registry = createArtifactChildRegistry(1);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      signalCode: null,
    });
    registry.track(child);

    await expect(registry.terminateAll('SIGTERM')).rejects.toThrow(
      'child cleanup was incomplete'
    );

    child.kill.mockImplementation((signal) => {
      child.signalCode = signal;
      child.emit('exit', null, signal);
    });
    await expect(
      registry.terminateAll('SIGINT', { permanent: true })
    ).resolves.toBeUndefined();

    expect(child.kill.mock.calls).toEqual([
      ['SIGTERM'],
      ['SIGKILL'],
      ['SIGINT'],
    ]);
    expect(registry.size).toBe(0);
    expect(() => registry.assertCanSpawn()).toThrow(
      'shutdown began before child spawn'
    );
  });

  it('keeps a child registered after an error until it closes', () => {
    const registry = createArtifactChildRegistry(1);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      signalCode: null,
    });
    registry.track(child);
    child.on('error', () => undefined);

    child.emit('error', new Error('kill failed'));
    expect(registry.size).toBe(1);

    child.emit('close', null, null);
    expect(registry.size).toBe(0);
  });

  it('makes the first shutdown signal authoritative and idempotent', async () => {
    const terminateAll = vi.fn().mockResolvedValue(undefined);
    const shutdown = createArtifactShutdownCoordinator({ terminateAll });

    const first = shutdown.request('SIGINT');
    const second = shutdown.request('SIGTERM');

    expect(second).toBe(first);
    await first;
    expect(terminateAll).toHaveBeenCalledTimes(1);
    expect(terminateAll).toHaveBeenCalledWith('SIGINT', { permanent: true });
    expect(shutdown.signal).toBe('SIGINT');
    expect(shutdown.exitCodeFor(new Error('later failure'))).toBe(130);
  });

  it('retries signal cleanup once after the first attempt fails', async () => {
    const initialError = new Error('ordinary cleanup failed');
    const terminateAll = vi
      .fn()
      .mockRejectedValueOnce(initialError)
      .mockResolvedValueOnce(undefined);
    const shutdown = createArtifactShutdownCoordinator({ terminateAll });

    await expect(shutdown.request('SIGTERM')).resolves.toBeUndefined();

    expect(terminateAll).toHaveBeenCalledTimes(2);
    expect(terminateAll).toHaveBeenNthCalledWith(1, 'SIGTERM', {
      permanent: true,
    });
    expect(terminateAll).toHaveBeenNthCalledWith(2, 'SIGTERM', {
      permanent: true,
    });
    expect(shutdown.exitCodeFor(initialError)).toBe(143);
  });

  it('aggregates both failures after exactly one signal cleanup retry', async () => {
    const initialError = new Error('first cleanup failed');
    const retryError = new Error('retry cleanup failed');
    const terminateAll = vi
      .fn()
      .mockRejectedValueOnce(initialError)
      .mockRejectedValueOnce(retryError);
    const shutdown = createArtifactShutdownCoordinator({ terminateAll });

    const failure = await shutdown.request('SIGINT').catch((error) => error);

    expect(terminateAll).toHaveBeenCalledTimes(2);
    expect(failure).toMatchObject({
      errors: [initialError, retryError],
      message: 'artifact signal cleanup failed after a bounded retry',
    });
    expect(shutdown.exitCodeFor(failure)).toBe(130);
  });

  it('drains signal cleanup errors before forcing the authoritative exit', async () => {
    const events = [];
    const failure = new AggregateError(
      [new Error('child survived')],
      'cleanup failed'
    );
    const shutdown = {
      exitCodeFor: vi.fn(() => 143),
      request: vi.fn().mockRejectedValue(failure),
    };

    await completeArtifactSignalShutdown({
      exit: (code) => events.push(`exit:${String(code)}`),
      shutdown,
      signal: 'SIGTERM',
      write: async (message) => {
        events.push(`write:${message}`);
      },
    });

    expect(events).toEqual([
      'write:cleanup failed\nchild survived',
      'exit:143',
    ]);
    expect(shutdown.request).toHaveBeenCalledWith('SIGTERM');
    expect(shutdown.exitCodeFor).toHaveBeenCalledWith();
  });

  it('forces the authoritative signal exit after successful cleanup', async () => {
    const exit = vi.fn();
    const shutdown = {
      exitCodeFor: vi.fn(() => 130),
      request: vi.fn().mockResolvedValue(undefined),
    };
    const write = vi.fn();

    await completeArtifactSignalShutdown({
      exit,
      shutdown,
      signal: 'SIGINT',
      write,
    });

    expect(write).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(130);
    expect(shutdown.exitCodeFor).toHaveBeenCalledWith();
  });

  it('forces the authoritative exit when the diagnostic sink fails', async () => {
    const exit = vi.fn();
    const failure = new Error('cleanup failed');
    const shutdown = {
      exitCodeFor: vi.fn(() => 143),
      request: vi.fn().mockRejectedValue(failure),
    };

    await completeArtifactSignalShutdown({
      exit,
      shutdown,
      signal: 'SIGTERM',
      write: vi.fn().mockRejectedValue(new Error('EPIPE')),
    });

    expect(exit).toHaveBeenCalledWith(143);
    expect(shutdown.exitCodeFor).toHaveBeenCalledWith();
  });

  it('drains a racing verification failure before the signal exit', async () => {
    const events = [];
    const verificationError = new Error('profile contract failed');
    let observedVerificationError;
    let finishVerification;
    const verificationCompletion = new Promise((resolve) => {
      finishVerification = () => {
        observedVerificationError = verificationError;
        resolve();
      };
    });
    const shutdown = {
      exitCodeFor: vi.fn(() => 143),
      request: vi.fn().mockResolvedValue(undefined),
    };

    const completion = completeArtifactSignalShutdown({
      exit: (code) => events.push(`exit:${String(code)}`),
      readVerificationError: () => observedVerificationError,
      shutdown,
      signal: 'SIGTERM',
      verificationCompletion,
      write: async (message) => {
        events.push(`write:${message}`);
      },
    });

    await Promise.resolve();
    expect(events).toEqual([]);
    finishVerification();
    await completion;

    expect(events).toEqual(['write:profile contract failed', 'exit:143']);
    expect(shutdown.exitCodeFor).toHaveBeenCalledWith();
  });

  it('forces the signal exit after a rejecting verification completion', async () => {
    const exit = vi.fn();
    const shutdown = {
      exitCodeFor: vi.fn(() => 143),
      request: vi.fn().mockResolvedValue(undefined),
    };

    await completeArtifactSignalShutdown({
      exit,
      shutdown,
      signal: 'SIGTERM',
      verificationCompletion: Promise.reject(
        new Error('profile contract failed')
      ),
      write: vi.fn(),
    });

    expect(exit).toHaveBeenCalledWith(143);
  });

  it('bounds a verification completion that never settles', async () => {
    const exit = vi.fn();
    const shutdown = {
      exitCodeFor: vi.fn(() => 130),
      request: vi.fn().mockResolvedValue(undefined),
    };

    await completeArtifactSignalShutdown({
      exit,
      finalizationTimeoutMs: 1,
      shutdown,
      signal: 'SIGINT',
      verificationCompletion: new Promise(() => undefined),
      write: vi.fn(),
    });

    expect(exit).toHaveBeenCalledWith(130);
  });

  it('shares one shrinking deadline across signal finalization stages', async () => {
    const readings = [0, 4, 9];
    const observedTimeouts = [];
    const settleWithin = async (completion, timeoutMs) => {
      observedTimeouts.push(timeoutMs);
      try {
        return { status: 'fulfilled', value: await completion };
      } catch (reason) {
        return { reason, status: 'rejected' };
      }
    };

    await completeArtifactSignalShutdown({
      exit: vi.fn(),
      finalizationTimeoutMs: 10,
      now: () => readings.shift(),
      settleWithin,
      shutdown: {
        exitCodeFor: vi.fn(() => 143),
        request: vi.fn().mockResolvedValue(undefined),
      },
      signal: 'SIGTERM',
    });

    expect(observedTimeouts).toEqual([6, 1]);
  });

  it('suppresses child failures caused by the requested signal', async () => {
    const exit = vi.fn();
    const write = vi.fn();
    const shutdown = {
      exitCodeFor: vi.fn(() => 143),
      request: vi.fn().mockResolvedValue(undefined),
    };

    await completeArtifactSignalShutdown({
      exit,
      readVerificationError: () =>
        Object.assign(new Error('vite stopped'), { signal: 'SIGTERM' }),
      shutdown,
      signal: 'SIGTERM',
      write,
    });

    expect(write).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(143);
  });

  it('settles every child termination when one child signal throws', async () => {
    const registry = createArtifactChildRegistry(10);
    const signalError = new Error('kill threw');
    const throwing = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(() => {
        throw signalError;
      }),
      signalCode: null,
    });
    const sibling = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn((signal) => {
        queueMicrotask(() => {
          sibling.signalCode = signal;
          sibling.emit('exit', null, signal);
        });
      }),
      signalCode: null,
    });
    registry.track(throwing);
    registry.track(sibling);

    const failure = await registry
      .terminateAll('SIGTERM')
      .catch((error) => error);

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors).toContain(signalError);
    expect(sibling.kill).toHaveBeenCalledWith('SIGTERM');
    expect(registry.size).toBe(1);
  });

  it('deduplicates concurrent registry termination and permits reuse after ordinary cleanup', async () => {
    const registry = createArtifactChildRegistry(10);
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(() => {
        queueMicrotask(() => {
          child.signalCode = 'SIGTERM';
          child.emit('exit', null, 'SIGTERM');
        });
      }),
      signalCode: null,
    });
    registry.track(child);

    await Promise.all([
      registry.terminateAll('SIGTERM'),
      registry.terminateAll('SIGTERM'),
    ]);

    expect(child.kill).toHaveBeenCalledOnce();
    expect(() => registry.assertCanSpawn()).not.toThrow();
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
