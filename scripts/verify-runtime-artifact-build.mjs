import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  createVerificationEnvironment,
  readGeneratedCapabilityPreset,
} from './runtime-verification-environment.mjs';
import { removeRuntimeArtifactOutput } from './runtime-artifact-output.mjs';
import { verifyRuntimeProfile } from './verify-runtime-profile.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profiles = new Set(['node', 'vercel', 'cloudflare']);

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

const runCommand = (command, args, env) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `${command} ${args.join(' ')} exited with ${
            code === null ? `signal ${signal}` : `code ${code}`
          }`
        )
      );
    });
  });

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
  await runCommand(path.join(root, 'node_modules/.bin/vite'), ['build'], env);
  verifyRuntimeProfile(selectedProfile, root, {
    expectedAppSlug: env.APP_SLUG,
    forbiddenBuildTokens: [env.VITE_BASE_URL],
  });
  console.log(`Verified ${selectedProfile} runtime artifact build contract.`);
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  verifyRuntimeArtifactBuild(process.argv[2]).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
