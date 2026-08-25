import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const profileNames = ['node', 'vercel', 'cloudflare'];
const profiles = new Set(profileNames);
const forbiddenRuntimeTokens = {
  cloudflare: [
    '@sentry/node',
    '@vercel/functions',
    '@vercel/otel',
    'AsyncLocalStorageContextManager',
    'NodeTracerProvider',
    '@opentelemetry/context-async-hooks',
    '@opentelemetry/sdk-trace-node',
    'telemetry_summary',
  ],
  node: [
    '@sentry/cloudflare',
    '@vercel/functions',
    '@vercel/otel',
    'cloudflare:workers',
    'START_UI_TELEMETRY_METRICS',
  ],
  vercel: [
    '@sentry/cloudflare',
    'cloudflare:workers',
    'initOpenTelemetryServer',
    'otel.node.initialize',
    'otel.server.shutdown',
    'START_UI_TELEMETRY_METRICS',
    'telemetry_summary',
  ],
};
const requiredRuntimeTokens = {
  cloudflare: ['cloudflare:workers', 'START_UI_TELEMETRY_METRICS'],
  node: ['NodeTracerProvider', '@opentelemetry/context-async-hooks'],
  vercel: ['@vercel/functions', '@vercel/otel'],
};

const fail = (message) => {
  throw new Error(`Runtime profile verification failed: ${message}`);
};

const assert = (condition, message) => {
  if (!condition) fail(message);
};

const assertFile = (filePath) =>
  assert(fs.statSync(filePath, { throwIfNoEntry: false })?.isFile(), filePath);

const assertDirectory = (directoryPath) =>
  assert(
    fs.statSync(directoryPath, { throwIfNoEntry: false })?.isDirectory(),
    directoryPath
  );

const hasCompatibilityFlag = (config, flag) =>
  Array.isArray(config.compatibility_flags) &&
  config.compatibility_flags.includes(flag);

const isCompatibilityDate = (value) =>
  typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value);

const readJson = (filePath) => {
  assertFile(filePath);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
};

const assertOnlyProfileMarker = (filePath, expectedProfile) => {
  assertFile(filePath);
  const source = fs.readFileSync(filePath, 'utf8');
  for (const profile of profileNames) {
    const marker = new RegExp(
      `createApplicationServerEntry\\(["']${profile}["'](?:\\s*[,\\)])`,
      'u'
    );
    assert(
      profile === expectedProfile ? marker.test(source) : !marker.test(source),
      `${filePath} must contain only the ${expectedProfile} profile marker`
    );
  }
};

const findFilesNamedLike = (directoryPath, predicate) => {
  return fs
    .readdirSync(directoryPath, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && predicate(entry.name))
    .map((entry) => path.join(entry.parentPath, entry.name));
};

const assertNoForbiddenRuntimeTokens = (directoryPath, profile) => {
  const files = findFilesNamedLike(directoryPath, (name) =>
    /\.(?:cjs|js|json|mjs)$/u.test(name)
  );
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, 'utf8');
    for (const token of forbiddenRuntimeTokens[profile]) {
      assert(
        !source.includes(token),
        `${filePath} contains forbidden ${profile} runtime token ${token}`
      );
    }
  }
};

const assertRequiredRuntimeTokens = (directoryPath, profile) => {
  const sources = findFilesNamedLike(directoryPath, (name) =>
    /\.(?:cjs|js|json|mjs)$/u.test(name)
  ).map((filePath) => fs.readFileSync(filePath, 'utf8'));
  for (const token of requiredRuntimeTokens[profile]) {
    assert(
      sources.some((source) => source.includes(token)),
      `${directoryPath} must contain ${profile} runtime owner ${token}`
    );
  }
};

const verifyNode = (root) => {
  const output = path.join(root, '.output/node');
  const manifest = readJson(path.join(output, 'nitro.json'));
  assert(manifest.preset === 'node-server', 'Node Nitro preset');
  assert(manifest.serverEntry === 'server/index.mjs', 'Node server entry');
  assert(manifest.publicDir === 'public', 'Node public directory');
  assertFile(path.join(output, manifest.serverEntry));
  assertDirectory(path.join(output, manifest.publicDir));
  assertOnlyProfileMarker(path.join(output, 'server/_ssr/ssr.mjs'), 'node');
  assertRequiredRuntimeTokens(path.join(output, 'server'), 'node');
  assertNoForbiddenRuntimeTokens(path.join(output, 'server'), 'node');
};

const verifyVercel = (root) => {
  const output = path.join(root, '.vercel/output');
  const manifest = readJson(path.join(output, 'nitro.json'));
  const buildOutput = readJson(path.join(output, 'config.json'));
  const functionConfig = readJson(
    path.join(output, 'functions/__server.func/.vc-config.json')
  );
  assert(manifest.preset === 'vercel', 'Vercel Nitro preset');
  assert(
    manifest.serverEntry === 'functions/__server.func/index.mjs',
    'Vercel server entry'
  );
  assert(buildOutput.version === 3, 'Vercel Build Output API v3');
  assert(functionConfig.runtime === 'nodejs24.x', 'Vercel Node 24 runtime');
  assert(functionConfig.supportsResponseStreaming, 'Vercel response streaming');
  assertFile(path.join(output, manifest.serverEntry));
  assertDirectory(path.join(output, manifest.publicDir));
  assertOnlyProfileMarker(
    path.join(output, 'functions/__server.func/_ssr/ssr.mjs'),
    'vercel'
  );
  assertRequiredRuntimeTokens(
    path.join(output, 'functions/__server.func'),
    'vercel'
  );
  assertNoForbiddenRuntimeTokens(
    path.join(output, 'functions/__server.func'),
    'vercel'
  );
};

const verifyCloudflare = (root, expectedAppSlug) => {
  const output = path.join(root, 'dist');
  const sourceConfig = readJson(path.join(root, 'wrangler.json'));
  const generatedConfig = readJson(path.join(output, 'server/wrangler.json'));
  assert(sourceConfig.main === 'src/server.ts', 'Cloudflare source entry');
  assert(
    hasCompatibilityFlag(sourceConfig, 'nodejs_compat'),
    'Cloudflare Sentry AsyncLocalStorage compatibility'
  );
  assert(
    typeof expectedAppSlug === 'string' && expectedAppSlug.length > 0,
    'APP_SLUG must be supplied for Cloudflare artifact verification'
  );
  assert(sourceConfig.name === expectedAppSlug, 'Cloudflare APP_SLUG identity');
  assert(generatedConfig.main === 'index.js', 'Cloudflare Worker entry');
  assert(
    generatedConfig.name === sourceConfig.name,
    'Cloudflare generated Worker name'
  );
  assert(
    isCompatibilityDate(sourceConfig.compatibility_date),
    'Cloudflare source compatibility date format'
  );
  assert(
    isCompatibilityDate(generatedConfig.compatibility_date),
    'Cloudflare generated compatibility date format'
  );
  assert(
    generatedConfig.compatibility_date === sourceConfig.compatibility_date,
    'Cloudflare generated compatibility date drift'
  );
  assert(
    hasCompatibilityFlag(generatedConfig, 'nodejs_compat'),
    'Cloudflare generated AsyncLocalStorage compatibility'
  );
  assert(
    generatedConfig.assets?.directory === '../client',
    'Cloudflare client asset binding'
  );
  assert(
    findFilesNamedLike(
      output,
      (name) => name === '.dev.vars' || name.startsWith('.dev.vars.')
    ).length === 0,
    'Cloudflare production output must not contain .dev.vars files'
  );
  assertDirectory(path.join(output, 'client'));
  assertOnlyProfileMarker(path.join(output, 'server/index.js'), 'cloudflare');
  assertRequiredRuntimeTokens(path.join(output, 'server'), 'cloudflare');
  assertNoForbiddenRuntimeTokens(path.join(output, 'server'), 'cloudflare');
};

export const verifyRuntimeProfile = (
  profile,
  root = process.cwd(),
  { expectedAppSlug = process.env.APP_SLUG } = {}
) => {
  assert(profiles.has(profile), `unknown profile ${String(profile)}`);
  if (profile === 'node') verifyNode(root);
  else if (profile === 'vercel') verifyVercel(root);
  else verifyCloudflare(root, expectedAppSlug);
  return profile;
};

const isEntryPoint =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntryPoint) {
  try {
    const profile = verifyRuntimeProfile(process.argv[2]);
    console.log(`Verified ${profile} runtime artifact contract.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
