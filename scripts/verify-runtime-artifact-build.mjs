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
  runtimeVerificationFailureExitCode,
  waitForSuccessfulChild,
} from './runtime-verification-child.mjs';
import { verifyRuntimeProfile } from './verify-runtime-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profiles = new Set(['node', 'vercel', 'cloudflare']);
const cloudflareProvenanceKeyEnvironment = 'START_UI_CLOUDFLARE_PROVENANCE_KEY';
const cloudflareProvenanceArtifact =
  'dist/server/start-ui-app-chunk-provenance.json';

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
  const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
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
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  verifyRuntimeArtifactBuild(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = runtimeVerificationFailureExitCode(error);
  });
}
