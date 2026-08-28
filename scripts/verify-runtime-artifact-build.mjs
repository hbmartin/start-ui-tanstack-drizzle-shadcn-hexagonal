import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createVerificationEnvironment,
  readGeneratedCapabilityPreset,
} from './runtime-verification-environment.mjs';
import { removeRuntimeArtifactOutput } from './runtime-artifact-output.mjs';
import {
  formatRuntimeVerificationError,
  runtimeVerificationFailureExitCode,
  waitForSuccessfulChild,
  writeRuntimeVerificationStderr,
} from './runtime-verification-child.mjs';
import { verifyRuntimeProfile } from './verify-runtime-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profiles = new Set(['node', 'vercel', 'cloudflare']);
const cloudflareProvenanceKeyEnvironment = 'START_UI_CLOUDFLARE_PROVENANCE_KEY';
const cloudflareProvenanceArtifact =
  'dist/server/start-ui-app-chunk-provenance.json';
const artifactChildShutdownTimeoutMs = 1_000;

const artifactChildExited = (child) =>
  child.exitCode !== null || child.signalCode !== null;

const waitForArtifactChildExit = (child, timeoutMs) => {
  if (artifactChildExited(child)) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (exited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.off('exit', onExit);
      child.off('close', onExit);
      // oxlint-disable-next-line promise/no-multiple-resolved -- The settled guard arbitrates the exit/timeout race.
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    child.once('exit', onExit);
    child.once('close', onExit);
    if (artifactChildExited(child)) finish(true);
  });
};

export const createArtifactChildRegistry = (
  shutdownTimeoutMs = artifactChildShutdownTimeoutMs
) => {
  const children = new Set();
  let permanentShutdownRequested = false;
  let shutdownRequested = false;
  let terminationPromise;
  const track = (child) => {
    if (shutdownRequested) {
      throw new Error(
        'artifact verification shutdown began before child spawn'
      );
    }
    children.add(child);
    const remove = () => children.delete(child);
    child.once('exit', remove);
    child.once('close', remove);
    return child;
  };
  const terminate = async (child, signal) => {
    if (artifactChildExited(child)) return true;
    child.kill(signal);
    if (await waitForArtifactChildExit(child, shutdownTimeoutMs)) return true;
    if (!artifactChildExited(child)) child.kill('SIGKILL');
    return waitForArtifactChildExit(child, shutdownTimeoutMs);
  };
  return {
    assertCanSpawn() {
      if (shutdownRequested) {
        throw new Error(
          'artifact verification shutdown began before child spawn'
        );
      }
    },
    get size() {
      return children.size;
    },
    async terminateAll(signal = 'SIGTERM', { permanent = false } = {}) {
      if (permanent) permanentShutdownRequested = true;
      shutdownRequested = true;
      terminationPromise ??= (async () => {
        const active = [...children];
        const results = await Promise.allSettled(
          active.map((child) => terminate(child, signal))
        );
        const terminationErrors = results.flatMap((result) =>
          result.status === 'rejected' ? [result.reason] : []
        );
        const survivors = active.filter(
          (_child, index) =>
            results[index].status === 'fulfilled' && !results[index].value
        );
        const failures = [
          ...terminationErrors,
          ...(survivors.length > 0
            ? [
                new Error(
                  `${String(survivors.length)} artifact verification child process(es) survived SIGKILL`
                ),
              ]
            : []),
        ];
        if (failures.length > 0) {
          throw new AggregateError(
            failures,
            'artifact verification child cleanup was incomplete'
          );
        }
      })();
      const activeTermination = terminationPromise;
      try {
        await activeTermination;
      } catch (error) {
        // A permanent signal shutdown may retry an ordinary cleanup that failed
        // while a child was still alive. Spawning remains disabled after failure.
        if (terminationPromise === activeTermination) {
          terminationPromise = undefined;
        }
        throw error;
      } finally {
        if (
          terminationPromise === activeTermination &&
          !permanentShutdownRequested
        ) {
          shutdownRequested = false;
          terminationPromise = undefined;
        }
      }
    },
    track,
  };
};

const artifactChildren = createArtifactChildRegistry();

export const createArtifactShutdownCoordinator = (registry) => {
  let requestedSignal;
  let shutdownPromise;
  return {
    exitCodeFor(error) {
      return runtimeVerificationFailureExitCode(
        requestedSignal ? { signal: requestedSignal } : error
      );
    },
    get signal() {
      return requestedSignal;
    },
    request(signal) {
      if (!requestedSignal) {
        requestedSignal = signal;
        shutdownPromise = (async () => {
          try {
            await registry.terminateAll(signal, { permanent: true });
          } catch (initialError) {
            try {
              await registry.terminateAll(signal, { permanent: true });
            } catch (retryError) {
              throw new AggregateError(
                [initialError, retryError],
                'artifact signal cleanup failed after a bounded retry'
              );
            }
          }
        })();
      }
      return shutdownPromise;
    },
  };
};

const artifactShutdown = createArtifactShutdownCoordinator(artifactChildren);

export const completeArtifactSignalShutdown = async ({
  exit = process.exit,
  readVerificationError = () => undefined,
  shutdown,
  signal,
  verificationCompletion = Promise.resolve(),
  write = writeRuntimeVerificationStderr,
}) => {
  let failure;
  try {
    await shutdown.request(signal);
  } catch (error) {
    failure = error;
    try {
      await write(formatRuntimeVerificationError(error));
    } catch {
      // A broken diagnostic sink must not prevent the authoritative signal exit.
    }
  }
  await Promise.race([
    verificationCompletion,
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  const verificationError = readVerificationError();
  if (verificationError) {
    try {
      await write(formatRuntimeVerificationError(verificationError));
    } catch {
      // A broken diagnostic sink must not prevent the authoritative signal exit.
    }
  }
  exit(shutdown.exitCodeFor(failure ?? verificationError));
};

export const createCloudflareArtifactProvenanceKey = () =>
  randomBytes(32).toString('base64url');

export const createArtifactBuildEnvironment = (
  profile,
  environment,
  cloudflareProvenanceKey
) =>
  profile === 'cloudflare'
    ? {
        ...environment,
        [cloudflareProvenanceKeyEnvironment]: cloudflareProvenanceKey,
      }
    : environment;

export const removeVerifiedCloudflareProvenance = (profile, projectRoot) => {
  if (profile !== 'cloudflare') return;
  fs.rmSync(path.join(projectRoot, cloudflareProvenanceArtifact), {
    force: true,
  });
};

const fail = (message) => {
  throw new Error(`Runtime artifact build verification failed: ${message}`);
};

export const parseArtifactProfile = (value) => {
  if (!profiles.has(value)) fail(`unknown profile ${String(value)}`);
  return value;
};

export const createArtifactVerificationEnvironment = (profile) => ({
  ...createVerificationEnvironment({
    appPort: 3_000,
    databasePort: 5_432,
    preset: readGeneratedCapabilityPreset(root),
    profile: parseArtifactProfile(profile),
    redisPort: 8_079,
  }),
  APP_SLUG: JSON.parse(
    fs.readFileSync(path.join(root, 'wrangler.json'), 'utf8')
  ).name,
});

const runCommand = (command, args, env) => {
  artifactChildren.assertCanSpawn();
  const child = artifactChildren.track(
    spawn(command, args, { cwd: root, env, stdio: 'inherit' })
  );
  return waitForSuccessfulChild(child, command, args);
};

const validateAndGenerate = (env) =>
  Promise.all([
    runCommand(
      process.execPath,
      ['./run-jiti', './scripts/validate-client-config.ts'],
      env
    ),
    runCommand(
      process.execPath,
      ['./run-jiti', './scripts/validate-server-build-config.ts'],
      env
    ),
    runCommand(
      process.execPath,
      [
        './run-jiti',
        './src/app/build-info/infrastructure/generate-build-info.ts',
      ],
      env
    ),
  ]);

export const verifyRuntimeArtifactBuild = async (profile) => {
  try {
    const selectedProfile = parseArtifactProfile(profile);
    const env = createArtifactVerificationEnvironment(selectedProfile);
    if (selectedProfile === 'cloudflare') {
      await runCommand(
        process.execPath,
        ['./scripts/cloudflare-build-preflight.mjs'],
        env
      );
    }
    removeRuntimeArtifactOutput(selectedProfile, root);
    await validateAndGenerate(env);
    const cloudflareProvenanceKey =
      selectedProfile === 'cloudflare'
        ? createCloudflareArtifactProvenanceKey()
        : undefined;
    const buildEnvironment = createArtifactBuildEnvironment(
      selectedProfile,
      env,
      cloudflareProvenanceKey
    );
    await runCommand(
      path.join(root, 'node_modules/.bin/vite'),
      ['build'],
      buildEnvironment
    );
    verifyRuntimeProfile(selectedProfile, root, {
      cloudflareAppChunkProvenanceKey: cloudflareProvenanceKey,
      expectedAppSlug: env.APP_SLUG,
      forbiddenArtifactSecrets: cloudflareProvenanceKey
        ? [cloudflareProvenanceKey]
        : [],
      forbiddenBuildTokens: [env.VITE_BASE_URL],
    });
    removeVerifiedCloudflareProvenance(selectedProfile, root);
    console.log(`Verified ${selectedProfile} runtime artifact build contract.`);
  } catch (error) {
    try {
      await artifactChildren.terminateAll();
    } catch (cleanupError) {
      const combined = new AggregateError(
        [error, cleanupError],
        'artifact verification failed and child cleanup was incomplete'
      );
      combined.exitCode = error?.exitCode;
      combined.signal = error?.signal;
      combined.status = error?.status;
      throw combined;
    }
    throw error;
  }
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  let signalShutdownStarted = false;
  let signalVerificationError;
  let verificationCompletion;
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      if (signalShutdownStarted) return;
      signalShutdownStarted = true;
      void completeArtifactSignalShutdown({
        readVerificationError: () => signalVerificationError,
        shutdown: artifactShutdown,
        signal,
        verificationCompletion,
      });
    });
  }
  verificationCompletion = verifyRuntimeArtifactBuild(process.argv[2]).catch(
    async (error) => {
      if (signalShutdownStarted) {
        signalVerificationError = error;
        return;
      }
      await writeRuntimeVerificationStderr(
        formatRuntimeVerificationError(error)
      );
      process.exitCode = artifactShutdown.exitCodeFor(error);
    }
  );
}
