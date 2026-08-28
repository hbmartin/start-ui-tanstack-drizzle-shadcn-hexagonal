import fs from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  inspectArtifactOwnerConsumerSourcesForTesting,
  inspectArtifactOwnerCallerComponentsForTesting,
  inspectAstTraversalForTesting,
  inspectCloudflareDeferredArgumentHazardForTesting,
  inspectCloudflareInvokedParameterProjectionsForTesting,
  inspectCloudflareLoadEffectsForTesting,
  inspectCloudflareModuleGraphBoundForTesting,
  inspectCloudflareReviewedReceiverMutationsForTesting,
  inspectFreeIdentifierReferencesForTesting,
  inspectTopLevelOwnerConsumerBoundForTesting,
  verifyRuntimeProfile as verifyRuntimeProfileImplementation,
} from '../../../scripts/verify-runtime-profile.mjs';

const compareCodePointStrings = (left, right) =>
  left < right ? -1 : left > right ? 1 : 0;
const dynamicOwnerSourceNames = {
  tanstack: 'src/entry-server.ts',
  telemetryProxy: 'src/platform/telemetry/index.ts',
};

const fixtureEmptyPluginAdaptersSource =
  'node_modules/.pnpm/@tanstack+start-server-core@1.169.15_fixture/node_modules/@tanstack/start-server-core/dist/esm/empty-plugin-adapters.js';
const fixtureCloudflareProvenanceKey = Buffer.alloc(32, 7).toString(
  'base64url'
);
const fixtureTanStackOwnerDigests = {
  createStartHandler:
    '6a9731e0a46846cce538b09b6afe5c18b74ad3e12349bfd87d5e25fe5f86bb70',
  defineHandlerCallback:
    '6a9731e0a46846cce538b09b6afe5c18b74ad3e12349bfd87d5e25fe5f86bb70',
  emptyPluginAdaptersChunk:
    '4ac630a35e14c193022ea8123bebd83f8452615b082cbdceeac56ed3d5fa1050',
  observedStreamHandler:
    '491fa0c918820444852f630fab2c40ab69b3ba30091a8c23cd9c7211aec395ba',
  routerLocalClosure:
    '4095cfe39799c83e4cfc0b053ea1ba8ce9d0bd4a87e545c4a621a8310cf0ebe6',
  serverClosure:
    '40bd64744f6aab4b68916c95d3387c634baa7e27ff0e037c46dc2399602fa062',
  serverEdgeClosure:
    '746f2dd8f008acc79f1783e259e0021736ca9acd54a68e2070ba45c7b0b6e18e',
  startOwnerClosure:
    '271a658e6e1cb30b63de34f38b6f8ea4c9b4024d8cdddc0442b516fe09587d27',
};
const verifyRuntimeProfile = (profile, root, options = {}) => {
  if (profile === 'cloudflare') writeFixtureCloudflareProvenance(root);
  return verifyRuntimeProfileImplementation(profile, root, {
    cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
    cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
    ...options,
  });
};

const emittedReviewDigest = (verify) => {
  try {
    verify();
    throw new Error('Expected a reviewed artifact digest diagnostic');
  } catch (error) {
    const match = String(error?.message).match(/\(([a-f0-9]{64})\)$/u);
    if (!match) throw error;
    return match[1];
  }
};

const subprocessReviewDigest = (root, locale) => {
  writeFixtureCloudflareProvenance(root);
  const verifierUrl = pathToFileURL(
    path.resolve(process.cwd(), 'scripts/verify-runtime-profile.mjs')
  ).href;
  const program = `import { verifyRuntimeProfile } from ${JSON.stringify(verifierUrl)};
try {
  verifyRuntimeProfile('cloudflare', ${JSON.stringify(root)}, {
    cloudflareAppChunkProvenanceKey: ${JSON.stringify(fixtureCloudflareProvenanceKey)},
    cloudflareTanStackOwnerDigests: ${JSON.stringify(fixtureTanStackOwnerDigests)},
    expectedAppSlug: 'acme-app',
  });
  throw new Error('Expected a reviewed artifact digest diagnostic');
} catch (error) {
  const match = String(error?.message).match(/\\(([a-f0-9]{64})\\)$/u);
  if (!match) throw error;
  process.stdout.write(match[1]);
}`;
  return execFileSync(
    process.execPath,
    ['--input-type=module', '--eval', program],
    {
      encoding: 'utf8',
      env: { ...process.env, LANG: locale, LC_ALL: locale },
    }
  );
};

const temporaryDirectories = [];

const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'start-ui-artifact-'));
  temporaryDirectories.push(root);
  return root;
};

const write = (root, relativePath, contents = '') => {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
};

const writeJson = (root, relativePath, value) =>
  write(root, relativePath, `${JSON.stringify(value)}\n`);

const fixtureAppOwnedModules = new Map();

const markFixtureAppOwnedChunk = (root, file, modules) => {
  const byFile = fixtureAppOwnedModules.get(root) ?? new Map();
  byFile.set(file, modules);
  fixtureAppOwnedModules.set(root, byFile);
};

const markOptionalFixtureAppOwnedChunk = (root, file, modules) => {
  if (!modules) return;
  markFixtureAppOwnedChunk(root, file, modules);
};

const readFixtureSourceOverride = (
  readFile,
  filePath,
  safeSource,
  candidate,
  options
) => {
  if (
    path.resolve(String(candidate)) === path.resolve(filePath) &&
    options === 'utf8'
  ) {
    return safeSource;
  }
  return readFile(candidate, options);
};

const fixtureJavaScriptFiles = (directory) =>
  fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory()) return fixtureJavaScriptFiles(candidate);
    return entry.isFile() && entry.name.endsWith('.js') ? [candidate] : [];
  });

const fixtureCloudflareOwnership = (modules) => {
  const appModules = modules.filter(({ owner }) => owner === 'app').length;
  if (appModules === modules.length) return 'app-only';
  return appModules > 0 ? 'mixed' : 'non-app';
};

const fixtureCloudflareAppSourceId = (sourceId) => {
  if (typeof sourceId !== 'string') return undefined;
  if (!sourceId.startsWith('src/')) return undefined;
  return sourceId;
};

const fixtureCloudflareSourceKey = (source, file) => {
  if (!source) return file;
  return source.key;
};

const fixtureCloudflareManifestModuleId = (source, file) => {
  const appSourceId = fixtureCloudflareAppSourceId(source?.src);
  if (appSourceId) return appSourceId;
  return `non-app:${fixtureCloudflareSourceKey(source, file)}`;
};

const fixtureCloudflareModuleIds = (explicitModules, source, file) => {
  const configuredModules = explicitModules.get(file);
  if (configuredModules) return configuredModules;
  return [fixtureCloudflareManifestModuleId(source, file)];
};

const fixtureCloudflareChunk = (
  artifactRoot,
  explicitModules,
  manifestSourcesByFile,
  chunkFile
) => {
  const file = path.relative(artifactRoot, chunkFile).split(path.sep).join('/');
  const source = manifestSourcesByFile.get(file);
  const modules = [...fixtureCloudflareModuleIds(explicitModules, source, file)]
    .map((id) => ({
      id,
      owner: id.startsWith('src/') ? 'app' : 'non-app',
    }))
    .sort((left, right) => compareCodePointStrings(left.id, right.id));
  return [
    file,
    {
      dynamicImports: [...(source?.dynamicImports ?? [])].sort(
        compareCodePointStrings
      ),
      imports: [...(source?.imports ?? [])].sort(compareCodePointStrings),
      modules,
      ownership: fixtureCloudflareOwnership(modules),
      sha256: createHash('sha256')
        .update(fs.readFileSync(chunkFile))
        .digest('hex'),
    },
  ];
};

const writeFixtureCloudflareProvenance = (
  root,
  { registerDetachedJavaScript = true } = {}
) => {
  const artifactRoot = path.join(root, 'dist/server');
  const manifest = JSON.parse(
    fs.readFileSync(path.join(artifactRoot, '.vite/manifest.json'), 'utf8')
  );
  const javascriptFiles = fixtureJavaScriptFiles(artifactRoot);
  if (registerDetachedJavaScript) {
    const manifestFiles = new Set(
      Object.values(manifest)
        .filter(
          (entry) =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof entry.file === 'string'
        )
        .map((entry) => entry.file)
    );
    javascriptFiles.forEach((chunkFile) => {
      const file = path
        .relative(artifactRoot, chunkFile)
        .split(path.sep)
        .join('/');
      if (manifestFiles.has(file)) return;
      manifest[`fixture:${file}`] = { file, name: `fixture:${file}` };
      manifestFiles.add(file);
    });
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  }
  const explicitModules = fixtureAppOwnedModules.get(root) ?? new Map();
  const manifestFilesByKey = new Map(
    Object.entries(manifest).flatMap(([key, entry]) =>
      typeof entry?.file === 'string' ? [[key, entry.file]] : []
    )
  );
  const manifestSourcesByFile = new Map(
    Object.entries(manifest)
      .filter(
        ([, entry]) =>
          typeof entry === 'object' &&
          entry !== null &&
          typeof entry.file === 'string' &&
          fs
            .statSync(path.join(artifactRoot, entry.file), {
              throwIfNoEntry: false,
            })
            ?.isFile()
      )
      .map(([key, entry]) => [
        entry.file,
        {
          dynamicImports: (entry.dynamicImports ?? []).map((edge) =>
            manifestFilesByKey.get(edge)
          ),
          imports: (entry.imports ?? []).map((edge) =>
            manifestFilesByKey.get(edge)
          ),
          key,
          src: entry.src,
        },
      ])
  );
  const chunks = Object.fromEntries(
    javascriptFiles
      .map((chunkFile) =>
        fixtureCloudflareChunk(
          artifactRoot,
          explicitModules,
          manifestSourcesByFile,
          chunkFile
        )
      )
      .sort(([left], [right]) => left.localeCompare(right))
  );
  const payload = Buffer.from(JSON.stringify({ chunks, version: 1 })).toString(
    'base64url'
  );
  writeJson(root, 'dist/server/start-ui-app-chunk-provenance.json', {
    algorithm: 'hmac-sha256',
    payload,
    signature: createHmac(
      'sha256',
      Buffer.from(fixtureCloudflareProvenanceKey, 'base64url')
    )
      .update(payload)
      .digest('base64url'),
    version: 1,
  });
};

const replaceManifestBackedHashedDependency = (
  root,
  {
    parentFile,
    parentManifestKey,
    replacementFile,
    replacementManifestKey,
    transform,
    trustedFile,
    trustedManifestKey,
  }
) => {
  const assets = path.join(root, 'dist/server/assets');
  write(
    root,
    `dist/server/assets/${replacementFile}`,
    transform(fs.readFileSync(path.join(assets, trustedFile), 'utf8'))
  );
  const parentPath = path.join(assets, parentFile);
  write(
    root,
    `dist/server/assets/${parentFile}`,
    fs.readFileSync(parentPath, 'utf8').replace(trustedFile, replacementFile)
  );
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest[replacementManifestKey] = {
    ...manifest[trustedManifestKey],
    file: `assets/${replacementFile}`,
  };
  const parentImports = manifest[parentManifestKey].imports;
  parentImports.splice(
    parentImports.indexOf(trustedManifestKey),
    1,
    replacementManifestKey
  );
  delete manifest[trustedManifestKey];
  fs.rmSync(path.join(assets, trustedFile));
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
};

const replaceManifestStaticEdge = (
  root,
  {
    ownerFile,
    ownerManifestKey,
    replacementEntry,
    replacementManifestKey,
    replacementSource,
    trustedManifestKey,
    trustedSource,
  }
) => {
  const ownerPath = path.join(root, ownerFile);
  write(
    root,
    ownerFile,
    fs.readFileSync(ownerPath, 'utf8').replace(trustedSource, replacementSource)
  );
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest[replacementManifestKey] = replacementEntry;
  const ownerImports = manifest[ownerManifestKey].imports;
  ownerImports.splice(
    ownerImports.indexOf(trustedManifestKey),
    1,
    replacementManifestKey
  );
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
};

const cloudflareSentryOwner =
  'const fetchCloudflareApplication=({context,handle,request,sentryOptions})=>sentryOptions?runWithCloudflareSentry({api:Sentry,handle,request,requestOptions:{captureErrors:false,context,options:sentryOptions,request}}):handle();';
const cloudflareRuntimeOwners =
  'var Sentry=await import("./assets/esm-fixture.js");' +
  'var {initializeCloudflareSentryApplication,runWithCloudflareSentry}=await import("./assets/sentry-request-fixture.js");' +
  'var {application,sentryRequestIsolationReady}=await initializeCloudflareSentryApplication(Sentry,async()=>{const kernel=await import("./assets/backend-kernel-fixture.js");kernel.requireRuntimeDatabaseClient();kernel.validateServerBuildConfig("cloudflare");const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");return createApplicationServerEntry("cloudflare")});' +
  'var {tracing}=await import("cloudflare:workers");' +
  'var {createNoOpTelemetry,reportTelemetryFailure}=await import("./assets/telemetry-entry-fixture.js");' +
  'var {createCloudflareTelemetryAdapter}=await import("./assets/telemetry-adapter-fixture.js");' +
  'var {runWithCloudflareDatabase}=await import("./assets/database-request-fixture.js");' +
  'var {configureCloudflareRequestTelemetry}=await import("./assets/request-telemetry-fixture.js");' +
  'var {scheduleCloudflareRequestFlush}=await import("./assets/request-lifecycle-fixture.js");' +
  'var lastKnownNativeTelemetry=createNoOpTelemetry();' +
  cloudflareSentryOwner;
const cloudflareSentryOptionsDeclaration =
  'const {sentryOptions}=configureCloudflareRequestTelemetry({environment,nativeTelemetry,request,sentry:Sentry,sentryRequestIsolationReady});';
const cloudflareNativeTelemetrySetup =
  'let nativeTelemetry=lastKnownNativeTelemetry;try{nativeTelemetry=createCloudflareTelemetryAdapter({analytics:environment.START_UI_TELEMETRY_METRICS,tracing});lastKnownNativeTelemetry=nativeTelemetry}catch(failure){reportTelemetryFailure("otel.cloudflare.configure",failure)}';
const cloudflareRequestFlush =
  'scheduleCloudflareRequestFlush(request,(completion)=>context.waitUntil(completion));';

const createNodeArtifact = (root) => {
  writeJson(root, '.output/node/nitro.json', {
    preset: 'node-server',
    publicDir: 'public',
    serverEntry: 'server/index.mjs',
  });
  write(root, '.output/node/server/index.mjs');
  write(
    root,
    '.output/node/server/_ssr/ssr.mjs',
    'const {initNodeTelemetry}=await import("../_libs/telemetry-bridge.mjs");await initNodeTelemetry();createApplicationServerEntry("node", undefined, runWithNodeSentryRequestIsolation);NodeTracerProvider'
  );
  write(
    root,
    '.output/node/server/_libs/telemetry-bridge.mjs',
    'import {n as initializeNodeTelemetryOnce} from "../_ssr/telemetry-owner.mjs";export {initializeNodeTelemetryOnce as initNodeTelemetry};'
  );
  write(
    root,
    '.output/node/server/_ssr/telemetry-owner.mjs',
    'const initializeSentryNodeRequestContext=()=>{};const create=()=>new SentryContextManager();const initNodeTelemetry=async()=>{await initializeSentryNodeRequestContext();create()};export {initNodeTelemetry as n};'
  );
  fs.mkdirSync(path.join(root, '.output/node/public'));
};

const createVercelArtifact = (root) => {
  writeJson(root, '.vercel/output/nitro.json', {
    preset: 'vercel',
    publicDir: 'static',
    serverEntry: 'functions/__server.func/index.mjs',
  });
  writeJson(root, '.vercel/output/config.json', { version: 3 });
  writeJson(root, '.vercel/output/functions/__server.func/.vc-config.json', {
    runtime: 'nodejs24.x',
    supportsResponseStreaming: true,
  });
  write(root, '.vercel/output/functions/__server.func/index.mjs');
  write(
    root,
    '.vercel/output/functions/__server.func/_ssr/ssr.mjs',
    'createApplicationServerEntry("vercel", vercelRequestLifecycle, runWithVercelSentryRequestIsolation);"@vercel/functions";"@vercel/otel"'
  );
  fs.mkdirSync(path.join(root, '.vercel/output/static'));
};

const createCloudflareArtifact = (root) => {
  writeJson(root, 'wrangler.json', {
    compatibility_date: '2026-08-24',
    compatibility_flags: ['nodejs_compat'],
    hyperdrive: [
      {
        binding: 'START_UI_DATABASE',
        id: '00000000-0000-0000-0000-000000000000',
      },
    ],
    main: 'src/server.ts',
    name: 'acme-app',
  });
  writeJson(root, 'dist/server/wrangler.json', {
    assets: { directory: '../client' },
    compatibility_date: '2026-08-24',
    compatibility_flags: ['nodejs_compat'],
    hyperdrive: [
      {
        binding: 'START_UI_DATABASE',
        id: '00000000-0000-0000-0000-000000000000',
      },
    ],
    main: 'index.js',
    name: 'acme-app',
  });
  writeJson(root, 'dist/server/.vite/manifest.json', {
    'virtual:cloudflare/worker-entry': {
      dynamicImports: [
        'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js',
        'src/runtime/cloudflare/sentry-request.ts',
        'src/modules/kernel/backend.ts',
        'src/runtime/create-application-server-entry.ts',
        'src/platform/telemetry/index.ts',
        'src/runtime/cloudflare/telemetry-adapter.ts',
        'src/runtime/cloudflare/database-request.ts',
        'src/runtime/cloudflare/request-telemetry.ts',
        'src/runtime/cloudflare/request-lifecycle.ts',
      ],
      file: 'index.js',
      isEntry: true,
      name: 'index',
      src: 'virtual:cloudflare/worker-entry',
    },
    'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js':
      {
        file: 'assets/esm-fixture.js',
        isDynamicEntry: true,
        name: 'esm',
        src: 'node_modules/.pnpm/@sentry+cloudflare@10.62.0/node_modules/@sentry/cloudflare/build/esm/index.js',
      },
    'src/runtime/create-application-server-entry.ts': {
      file: 'assets/create-application-server-entry-fixture.js',
      imports: [
        '_telemetry-fixture.js',
        '_request-exception-state-fixture.js',
        '_request-failure-fixture.js',
      ],
      dynamicImports: [
        'src/platform/telemetry/index.ts',
        'src/entry-server.ts',
      ],
      isDynamicEntry: true,
      name: 'create-application-server-entry',
      src: 'src/runtime/create-application-server-entry.ts',
    },
    'src/modules/kernel/backend.ts': {
      file: 'assets/backend-kernel-fixture.js',
      imports: [
        '_auth-fixture.js',
        '_telemetry-fixture.js',
        '_client-fixture.js',
        '_runtime-fixture.js',
        '_backend-build-config-fixture.js',
        '_book-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'backend',
      src: 'src/modules/kernel/backend.ts',
    },
    '_backend-fixture.js': {
      file: 'assets/backend-fixture.js',
      imports: [],
      name: 'backend',
    },
    '_auth-fixture.js': {
      file: 'assets/auth-fixture.js',
      imports: [],
      name: 'auth',
    },
    '_backend-build-config-fixture.js': {
      file: 'assets/backend-build-config-fixture.js',
      imports: [],
      name: 'backend',
    },
    '_client-fixture.js': {
      file: 'assets/client-fixture.js',
      imports: [],
      name: 'client',
    },
    '_book-fixture.js': {
      file: 'assets/book-fixture.js',
      imports: [],
      name: 'book',
    },
    '_react-fixture.js': {
      file: 'assets/react-fixture.js',
      imports: [],
      name: 'react',
    },
    '_rolldown-runtime-fixture.js': {
      file: 'assets/rolldown-runtime-fixture.js',
      imports: [],
      name: 'rolldown-runtime',
    },
    '_runtime-fixture.js': {
      file: 'assets/runtime-fixture.js',
      imports: [],
      name: 'runtime',
    },
    '_sanitize-log-fields-fixture.js': {
      file: 'assets/sanitize-log-fields-fixture.js',
      imports: [],
      name: 'sanitize-log-fields',
    },
    '_server-fixture.js': {
      dynamicImports: [
        'tanstack-start-manifest:v',
        'src/router.tsx',
        'src/start.ts',
        fixtureEmptyPluginAdaptersSource,
      ],
      file: 'assets/server-fixture.js',
      imports: ['_createCsrfMiddleware-AAAAAAAA.js'],
      name: 'server',
    },
    '_server.edge-fixture.js': {
      file: 'assets/server.edge-fixture.js',
      imports: ['_react-dom-AAAAAAAA.js'],
      name: 'server.edge',
    },
    '_createCsrfMiddleware-AAAAAAAA.js': {
      file: 'assets/createCsrfMiddleware-AAAAAAAA.js',
      imports: ['_server-fixture.js', '_cycle-marker-AAAAAAAA.js'],
      name: 'createCsrfMiddleware',
    },
    '_cycle-marker-AAAAAAAA.js': {
      file: 'runtime/cycle-marker-AAAAAAAA.js',
      imports: [],
      name: 'cycle-marker',
    },
    [fixtureEmptyPluginAdaptersSource]: {
      file: 'assets/empty-plugin-adapters-AAAAAAAA.js',
      isDynamicEntry: true,
      imports: [],
      name: 'empty-plugin-adapters',
      src: fixtureEmptyPluginAdaptersSource,
    },
    'src/router.tsx': {
      file: 'assets/router-AAAAAAAA.js',
      isDynamicEntry: true,
      imports: [],
      name: 'router',
      src: 'src/router.tsx',
    },
    'src/start.ts': {
      file: 'assets/start-AAAAAAAA.js',
      isDynamicEntry: true,
      imports: [],
      name: 'start',
      src: 'src/start.ts',
    },
    'tanstack-start-manifest:v': {
      file: 'assets/tanstack-start-manifest-AAAAAAAA.js',
      isDynamicEntry: true,
      imports: [],
      name: 'tanstack-start-manifest',
      src: 'tanstack-start-manifest:v',
    },
    '_react-dom-AAAAAAAA.js': {
      file: 'assets/react-dom-AAAAAAAA.js',
      imports: [],
      name: 'react-dom',
    },
    '_structured-console-fixture.js': {
      file: 'assets/structured-console-fixture.js',
      imports: [],
      name: 'structured-console',
    },
    '_tags-fixture.js': {
      file: 'assets/tags-fixture.js',
      imports: [],
      name: 'tags',
    },
    '_request-completion-fixture.js': {
      file: 'assets/request-completion-fixture.js',
      imports: ['_telemetry-fixture.js'],
      name: 'request-completion',
    },
    '_request-exception-state-fixture.js': {
      file: 'assets/request-exception-state-fixture.js',
      imports: [],
      name: 'request-exception-state',
    },
    '_request-failure-fixture.js': {
      file: 'assets/request-failure-fixture.js',
      imports: [],
      name: 'request-failure',
    },
    '_telemetry-fixture.js': {
      file: 'assets/telemetry-fixture.js',
      imports: [],
      name: 'telemetry',
    },
    'src/entry-server.ts': {
      file: 'assets/entry-server-fixture.js',
      imports: [
        '_rolldown-runtime-fixture.js',
        '_react-fixture.js',
        '_server-fixture.js',
        '_server.edge-fixture.js',
        '_telemetry-fixture.js',
        '_request-completion-fixture.js',
        '_request-exception-state-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'entry-server',
      src: 'src/entry-server.ts',
    },
    'src/platform/telemetry/index.ts': {
      file: 'assets/telemetry-entry-fixture.js',
      imports: [
        '_tags-fixture.js',
        '_telemetry-fixture.js',
        '_request-completion-fixture.js',
        '_request-exception-state-fixture.js',
        '_structured-console-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'telemetry',
      src: 'src/platform/telemetry/index.ts',
    },
    'src/runtime/cloudflare/database-request.ts': {
      file: 'assets/database-request-fixture.js',
      imports: [
        '_client-fixture.js',
        '_backend-fixture.js',
        '_telemetry-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'database-request',
      src: 'src/runtime/cloudflare/database-request.ts',
    },
    'src/runtime/cloudflare/request-lifecycle.ts': {
      file: 'assets/request-lifecycle-fixture.js',
      imports: ['_telemetry-fixture.js', '_request-completion-fixture.js'],
      isDynamicEntry: true,
      name: 'request-lifecycle',
      src: 'src/runtime/cloudflare/request-lifecycle.ts',
    },
    'src/runtime/cloudflare/request-telemetry.ts': {
      file: 'assets/request-telemetry-fixture.js',
      imports: [
        '_tags-fixture.js',
        '_sanitize-log-fields-fixture.js',
        '_telemetry-fixture.js',
      ],
      isDynamicEntry: true,
      name: 'request-telemetry',
      src: 'src/runtime/cloudflare/request-telemetry.ts',
    },
    'src/runtime/cloudflare/sentry-request.ts': {
      file: 'assets/sentry-request-fixture.js',
      imports: ['_telemetry-fixture.js', '_request-completion-fixture.js'],
      isDynamicEntry: true,
      name: 'sentry-request',
      src: 'src/runtime/cloudflare/sentry-request.ts',
    },
    'src/runtime/cloudflare/telemetry-adapter.ts': {
      file: 'assets/telemetry-adapter-fixture.js',
      imports: ['_telemetry-fixture.js', '_structured-console-fixture.js'],
      isDynamicEntry: true,
      name: 'telemetry-adapter',
      src: 'src/runtime/cloudflare/telemetry-adapter.ts',
    },
  });
  write(
    root,
    'dist/server/index.js',
    `${cloudflareRuntimeOwners}var worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{${cloudflareRequestFlush}}}};export{worker_entry_default as default};`
  );
  write(
    root,
    'dist/server/assets/esm-fixture.js',
    'const setAsyncLocalStorageAsyncContextStrategy=()=>{};const withScope=(handle)=>handle();const wrapRequestHandler=(_options,handle)=>handle();export{setAsyncLocalStorageAsyncContextStrategy,withScope,wrapRequestHandler};'
  );
  write(
    root,
    'dist/server/assets/sentry-request-fixture.js',
    'import{reportTelemetryFailure}from"./telemetry-fixture.js";import{n as registerRequestCompletion,r as snapshotRequestCompletions}from"./request-completion-fixture.js";const sentrySentinelResponse=(applicationCompletion)=>new Response(new ReadableStream({start(controller){applicationCompletion.then(()=>controller.close(),()=>controller.close())}}),{headers:{"content-type":"text/plain; charset=utf-8"},status:200});const sentryLifecycleRequest=(request)=>{if(request.method!=="HEAD"&&request.method!=="OPTIONS")return request;return new Request(request.url,{headers:request.headers,method:"GET"})};const initializeCloudflareSentryIsolation=(api)=>{try{api.setAsyncLocalStorageAsyncContextStrategy();return true}catch(failure){reportTelemetryFailure("sentry.cloudflare.async_context",failure);return false}};const initializeCloudflareSentryApplication=async(api,loadApplication)=>{const sentryRequestIsolationReady=initializeCloudflareSentryIsolation(api);return{application:await loadApplication(),sentryRequestIsolationReady}};const runWithCloudflareSentry=async({api,handle,request,requestOptions})=>{let applicationOutcome;let applicationWork;const runApplicationOnce=()=>{applicationWork??=Promise.resolve().then(async()=>{try{return{response:await handle(),type:"responded"}}catch(failure){return{failure,type:"failed"}}});return applicationWork};try{const sentryResponse=await api.withScope(()=>api.wrapRequestHandler({...requestOptions,request:sentryLifecycleRequest(request)},async()=>{applicationOutcome=await runApplicationOnce();if(applicationOutcome.type==="failed")throw applicationOutcome.failure;return sentrySentinelResponse(Promise.allSettled(snapshotRequestCompletions(request)))}));if(sentryResponse.body){const sentryCompletion=sentryResponse.arrayBuffer().then(()=>void 0).catch((failure)=>{reportTelemetryFailure("sentry.cloudflare.request_stream",failure)});registerRequestCompletion(request,sentryCompletion)}}catch(failure){if(applicationOutcome?.type==="failed")throw applicationOutcome.failure;reportTelemetryFailure("sentry.cloudflare.request",failure)}if(applicationOutcome?.type==="responded")return applicationOutcome.response;if(applicationOutcome?.type==="failed")throw applicationOutcome.failure;reportTelemetryFailure("sentry.cloudflare.request",new Error("Sentry request wrapper skipped application handler"));applicationOutcome=await runApplicationOnce();if(applicationOutcome.type==="failed")throw applicationOutcome.failure;return applicationOutcome.response};export{initializeCloudflareSentryApplication,runWithCloudflareSentry};'
  );
  write(
    root,
    'dist/server/assets/database-request-fixture.js',
    'import{createHyperdriveDbClient,runWithRuntimeDatabaseClient}from"./client-fixture.js";import{validateServerConfig}from"./backend-fixture.js";import{reportTelemetryFailure}from"./telemetry-fixture.js";const closeDatabase=async(database)=>{try{await database.$close()}catch(failure){reportTelemetryFailure("database.cloudflare.close",failure)}};const captureDatabaseConnectionFailure=()=>{};const bindCloudflareDatabaseToResponse=({database,request,response})=>{if(!response.body){closeDatabase(database);return response}if(response.bodyUsed||response.body.locked)throw new TypeError("locked");const{readable,writable}=new TransformStream();response.body.pipeTo(writable,{signal:request.signal}).catch(()=>void 0).then(()=>closeDatabase(database));return new Response(readable,response)};const runWithCloudflareDatabase=async({binding,handle,request})=>{let database;try{database=await createHyperdriveDbClient(binding)}catch(failure){captureDatabaseConnectionFailure(failure);throw failure}return runWithRuntimeDatabaseClient(database,async()=>{try{validateServerConfig("cloudflare",{databaseAdapter:database.$adapter});const response=await handle();return bindCloudflareDatabaseToResponse({database,request,response})}catch(failure){await closeDatabase(database);throw failure}})};export{runWithCloudflareDatabase};'
  );
  write(
    root,
    'dist/server/assets/request-telemetry-fixture.js',
    'import{toTelemetryStringTags}from"./tags-fixture.js";import{sanitizeLogFields}from"./sanitize-log-fields-fixture.js";import{reportTelemetryFailure,setTelemetry}from"./telemetry-fixture.js";const createCloudflareSentryOptions=()=>({});const createSentryTelemetryAdapter=()=>({});const createTelemetryAdapterChain=()=>({});const configureCloudflareRequestTelemetry=({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>{setTelemetry(nativeTelemetry);if(!environment.SENTRY_DSN||!sentryRequestIsolationReady){return{}}try{const sentryOptions=createCloudflareSentryOptions(sentry,request,environment);const sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});setTelemetry(createTelemetryAdapterChain([nativeTelemetry,sentryTelemetry]));return{sentryOptions}}catch(failure){reportTelemetryFailure("sentry.cloudflare.configure",failure);return{}}};export{configureCloudflareRequestTelemetry};'
  );
  write(
    root,
    'dist/server/assets/request-lifecycle-fixture.js',
    'import{getTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";const scheduleCloudflareRequestFlush=(request,waitUntil)=>{const flush=forceFlushRequestTelemetry(request,getTelemetry()).then(()=>void 0);try{waitUntil(flush)}catch(failure){reportTelemetryFailure("otel.cloudflare.wait_until",failure)}};export{scheduleCloudflareRequestFlush};'
  );
  write(
    root,
    'dist/server/assets/telemetry-entry-fixture.js',
    'import"./tags-fixture.js";import{createNoOpTelemetry,reportTelemetryFailure,telemetryProxy}from"./telemetry-fixture.js";import"./request-completion-fixture.js";import"./request-exception-state-fixture.js";import"./structured-console-fixture.js";export{createNoOpTelemetry,reportTelemetryFailure,telemetryProxy};'
  );
  write(
    root,
    'dist/server/assets/telemetry-adapter-fixture.js',
    'import"./telemetry-fixture.js";import{writeStructuredConsoleLog}from"./structured-console-fixture.js";const createCloudflareTelemetryAdapter=()=>({});export{createCloudflareTelemetryAdapter};'
  );
  write(
    root,
    'dist/server/assets/create-application-server-entry-fixture.js',
    'import{reportTelemetryFailure}from"./telemetry-fixture.js";import{n as claimRequestException,r as createRequestExceptionCaptureState,t as bindRequestExceptionState}from"./request-exception-state-fixture.js";import{t as isUnexpectedRequestFailure}from"./request-failure-fixture.js";const createApplicationServerEntry=async(runtimeProfile,lifecycle,requestScope)=>{const{telemetryProxy}=await import("./telemetry-entry-fixture.js");const tanstack=await import("./entry-server-fixture.js");return tanstack.createServerEntry({async fetch(request){const handleRequest=async()=>{const telemetryCaptureState=createRequestExceptionCaptureState();bindRequestExceptionState(request,telemetryCaptureState);const context={requestId:crypto.randomUUID(),runtimeProfile,telemetryCaptureState};try{return await tanstack.default.fetch(request,{context})}catch(error){if(isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error))telemetryProxy.captureException(error,{level:"error",tags:{event:"framework.request.failed",requestId:context.requestId}});throw error}finally{try{lifecycle?.onRequestSettled(request)}catch{}}};if(!requestScope)return handleRequest();let applicationResult;const runApplicationOnce=()=>{applicationResult??=handleRequest();return applicationResult};try{return requestScope(runApplicationOnce)}catch(failure){reportTelemetryFailure("sentry.request_scope",failure);return applicationResult??runApplicationOnce()}}})};export{createApplicationServerEntry};'
  );
  write(
    root,
    'dist/server/assets/entry-server-fixture.js',
    'import{__toESM}from"./rolldown-runtime-fixture.js";import{require_react}from"./react-fixture.js";import{createSsrStreamResponse,createStartHandler,defineHandlerCallback,isbot,StartServer,transformReadableStreamWithRouter}from"./server-fixture.js";import{require_server_edge}from"./server.edge-fixture.js";import"./telemetry-fixture.js";import{n as registerRequestCompletion}from"./request-completion-fixture.js";import{r as createRequestExceptionCaptureState,getRequestExceptionState}from"./request-exception-state-fixture.js";const import_react=__toESM(require_react(),1);const import_server_edge=__toESM(require_server_edge(),1);const noop=()=>{};const isAbortError=()=>false;const waitForReadyOrAbort=async()=>{};const observedStreamHandler=defineHandlerCallback(async({request,responseHeaders,router})=>{const exceptionCaptureState=getRequestExceptionState(request)??createRequestExceptionCaptureState();const stream=await import_server_edge.renderToReadableStream(import_react.createElement(StartServer,{router}));registerRequestCompletion(request,stream);if(isbot(request.headers.get("user-agent")))await waitForReadyOrAbort(stream,request.signal);const responseStream=transformReadableStreamWithRouter(router,stream);const response=new Response(responseStream,{headers:responseHeaders,status:router.stores.statusCode.get()});return createSsrStreamResponse(router,response)});const entry={fetch:createStartHandler(observedStreamHandler)};const createServerEntry=(serverEntry)=>serverEntry;export{createServerEntry,entry as default};'
  );
  write(
    root,
    'dist/server/assets/client-fixture.js',
    'const createHyperdriveDbClient=()=>({});const requireRuntimeDatabaseClient=()=>{};const runWithRuntimeDatabaseClient=(_database,handle)=>handle();export{createHyperdriveDbClient,requireRuntimeDatabaseClient,runWithRuntimeDatabaseClient};'
  );
  write(
    root,
    'dist/server/assets/backend-fixture.js',
    'const validateServerConfig=()=>{};export{validateServerConfig};'
  );
  write(
    root,
    'dist/server/assets/backend-kernel-fixture.js',
    'import"./auth-fixture.js";import"./telemetry-fixture.js";import{requireRuntimeDatabaseClient}from"./client-fixture.js";import"./runtime-fixture.js";import{validateServerBuildConfig}from"./backend-build-config-fixture.js";import"./book-fixture.js";export{requireRuntimeDatabaseClient,validateServerBuildConfig};'
  );
  write(
    root,
    'dist/server/assets/backend-build-config-fixture.js',
    'const validateServerBuildConfig=()=>{};export{validateServerBuildConfig};'
  );
  write(
    root,
    'dist/server/assets/request-exception-state-fixture.js',
    'const claimRequestException=()=>true;const createRequestExceptionCaptureState=()=>({});const bindRequestExceptionState=()=>{};const getRequestExceptionState=()=>{};export{claimRequestException as n,createRequestExceptionCaptureState as r,bindRequestExceptionState as t,getRequestExceptionState};'
  );
  write(
    root,
    'dist/server/assets/request-failure-fixture.js',
    'const isUnexpectedRequestFailure=()=>true;export{isUnexpectedRequestFailure as t};'
  );
  write(
    root,
    'dist/server/assets/request-completion-fixture.js',
    'import{reportTelemetryFailure}from"./telemetry-fixture.js";const forceFlushRequestTelemetry=()=>Promise.resolve();const registerRequestCompletion=()=>{};const snapshotRequestCompletions=()=>[];export{forceFlushRequestTelemetry,registerRequestCompletion as n,snapshotRequestCompletions as r};'
  );
  write(
    root,
    'dist/server/assets/telemetry-fixture.js',
    'const createNoOpTelemetry=()=>({});const getTelemetry=()=>({});const reportTelemetryFailure=()=>{};const setTelemetry=()=>{};const telemetryProxy={};export{createNoOpTelemetry,getTelemetry,reportTelemetryFailure,setTelemetry,telemetryProxy};'
  );
  write(
    root,
    'dist/server/assets/rolldown-runtime-fixture.js',
    'const __toESM=(value)=>value;export{__toESM};'
  );
  write(
    root,
    'dist/server/assets/react-fixture.js',
    'const require_react=()=>({});export{require_react};'
  );
  write(
    root,
    'dist/server/assets/server-fixture.js',
    'import{createCsrfMiddleware}from"./createCsrfMiddleware-AAAAAAAA.js";const loadOwners=()=>Promise.all([import("./tanstack-start-manifest-AAAAAAAA.js"),import("./router-AAAAAAAA.js"),import("./start-AAAAAAAA.js"),import("./empty-plugin-adapters-AAAAAAAA.js")]);const createSsrStreamResponse=(_router,response)=>response;const createStartHandler=(handler)=>handler;const defineHandlerCallback=(handler)=>handler;const isbot=()=>false;const StartServer=()=>{};const transformReadableStreamWithRouter=(stream)=>stream;export{createSsrStreamResponse,createStartHandler,defineHandlerCallback,isbot,StartServer,transformReadableStreamWithRouter};'
  );
  write(
    root,
    'dist/server/assets/server.edge-fixture.js',
    'import{renderToReadableStream}from"./react-dom-AAAAAAAA.js";const require_server_edge=()=>({renderToReadableStream});export{require_server_edge};'
  );
  write(
    root,
    'dist/server/assets/createCsrfMiddleware-AAAAAAAA.js',
    'import"node:stream";import"./server-fixture.js";export{serverCycleMarker}from"../runtime/cycle-marker-AAAAAAAA.js";const createCsrfMiddleware=()=>{};export{createCsrfMiddleware};'
  );
  write(
    root,
    'dist/server/runtime/cycle-marker-AAAAAAAA.js',
    'const serverCycleMarker=true;export{serverCycleMarker};'
  );
  write(
    root,
    'dist/server/assets/empty-plugin-adapters-AAAAAAAA.js',
    'const emptyPluginAdapter=true;export{emptyPluginAdapter};'
  );
  write(
    root,
    'dist/server/assets/router-AAAAAAAA.js',
    'const getRouterCspNonce=()=>undefined;function getRouter(){const cspNonce=getRouterCspNonce();return{cspNonce}}export{getRouter};'
  );
  write(
    root,
    'dist/server/assets/start-AAAAAAAA.js',
    'const startInstance={};export{startInstance};'
  );
  write(
    root,
    'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
    'const tsrStartManifest=()=>({routes:{}});export{tsrStartManifest};'
  );
  write(
    root,
    'dist/server/assets/react-dom-AAAAAAAA.js',
    'const renderToReadableStream=()=>new ReadableStream();export{renderToReadableStream};'
  );
  write(
    root,
    'dist/server/assets/tags-fixture.js',
    'const toTelemetryStringTags=()=>({});export{toTelemetryStringTags};'
  );
  write(
    root,
    'dist/server/assets/sanitize-log-fields-fixture.js',
    'const sanitizeLogFields=()=>({});export{sanitizeLogFields};'
  );
  write(
    root,
    'dist/server/assets/structured-console-fixture.js',
    'const writeStructuredConsoleLog=()=>{};export{writeStructuredConsoleLog};'
  );
  for (const emptyChunk of ['auth', 'book', 'runtime']) {
    write(root, `dist/server/assets/${emptyChunk}-fixture.js`);
  }
  fs.mkdirSync(path.join(root, 'dist/client'));
};

const addCloudflareSinkModule = (root, source) => {
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['src/start.ts'].imports = ['_sink-AAAAAAAA.js'];
  manifest['_sink-AAAAAAAA.js'] = {
    file: 'assets/sink-AAAAAAAA.js',
    imports: [],
    name: 'sink',
  };
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  write(root, 'dist/server/assets/sink-AAAAAAAA.js', source);
};

const addCloudflareLoadEffectCycle = (root, size) => {
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const fileName = (index) =>
    `load-effect-cycle-${String(index).padStart(4, '0')}.js`;
  const manifestKey = (index) =>
    `_load-effect-cycle-${String(index).padStart(4, '0')}.js`;
  manifest['src/start.ts'].imports = [manifestKey(0)];
  write(
    root,
    'dist/server/assets/start-AAAAAAAA.js',
    `import"./${fileName(0)}";const startInstance={};export{startInstance};`
  );
  for (let index = 0; index < size; index += 1) {
    const next = (index + 1) % size;
    manifest[manifestKey(index)] = {
      file: `assets/${fileName(index)}`,
      imports: [manifestKey(next)],
      name: `load-effect-cycle-${index}`,
    };
    write(
      root,
      `dist/server/assets/${fileName(index)}`,
      `import{step as next}from"./${fileName(next)}";const step=()=>{};next();export{step};`
    );
    markFixtureAppOwnedChunk(root, `assets/${fileName(index)}`, [
      `src/load-effect-cycle/${index}.ts`,
    ]);
  }
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
};

const addCloudflareRouterEffectModule = (
  root,
  caller,
  owner,
  modules = ['src/router-effect.ts']
) => {
  const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
  const routerPath = path.join(root, routerRelativePath);
  write(
    root,
    routerRelativePath,
    `${caller}${fs.readFileSync(routerPath, 'utf8')}`
  );
  write(root, 'dist/server/assets/router-effect-AAAAAAAA.js', owner);
  const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest['_router-effect-AAAAAAAA.js'] = {
    file: 'assets/router-effect-AAAAAAAA.js',
    imports: [],
    name: 'router-effect',
  };
  manifest['src/router.tsx'].imports = ['_router-effect-AAAAAAAA.js'];
  writeJson(root, 'dist/server/.vite/manifest.json', manifest);
  if (modules) {
    markFixtureAppOwnedChunk(root, 'assets/router-effect-AAAAAAAA.js', modules);
  }
};

const emittedStartOwnerClosure = (root) =>
  emittedReviewDigest(() =>
    verifyRuntimeProfile('cloudflare', root, {
      expectedAppSlug: 'acme-app',
    })
  );

const expectStartOwnerSubstitutionRejected = (root, startOwnerClosure) => {
  expect(() =>
    verifyRuntimeProfile('cloudflare', root, {
      cloudflareTanStackOwnerDigests: {
        ...fixtureTanStackOwnerDigests,
        startOwnerClosure,
      },
      expectedAppSlug: 'acme-app',
    })
  ).toThrow('must use the reviewed startInstance artifact owner closure');
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { force: true, recursive: true });
  }
});

describe('runtime artifact verifier', () => {
  it('bounds deferred-argument aggregate traversal without recursive stack growth', () => {
    const nested = `const payload=${'['.repeat(1_024)}()=>1${']'.repeat(1_024)};`;
    expect(
      inspectCloudflareDeferredArgumentHazardForTesting(nested, 'payload')
    ).toBe(false);

    const broad = `const payload=[${Array.from(
      { length: 150_000 },
      () => '()=>1'
    ).join(',')}];`;
    expect(() =>
      inspectCloudflareDeferredArgumentHazardForTesting(broad, 'payload')
    ).toThrow('exceeded bounded candidate work');
  });

  it('traverses a wide AST without variadic frontier stack growth', () => {
    const source = `const payload=[${Array.from(
      { length: 150_000 },
      () => '0'
    ).join(',')}];`;

    expect(inspectAstTraversalForTesting(source)).toBe(true);
  });

  it('uses the iterative production visitor for a deeply nested Program', () => {
    const source = `const value=${'['.repeat(5_000)}0${']'.repeat(5_000)};`;

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('bounds deep free-reference traversal before recursive scope analysis', () => {
    const source = `const value=${'['.repeat(2_048)}external${']'.repeat(2_048)};`;

    expect(() => inspectFreeIdentifierReferencesForTesting(source)).toThrow(
      'exceeded bounded AST depth'
    );
  });

  it('bounds deeply nested binding patterns before recursive projection', () => {
    const source = `const ${'['.repeat(2_048)}value${']'.repeat(2_048)}=[];`;

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'exceeded bounded binding-pattern depth'
    );
  });

  it('bounds a wide caller graph before enqueueing its frontier', () => {
    expect(() =>
      inspectArtifactOwnerCallerComponentsForTesting(150_000)
    ).toThrow('exceeded bounded candidate work');
  });

  it('bounds a wide manifest closure before enqueueing its frontier', () => {
    expect(() => inspectCloudflareModuleGraphBoundForTesting(150_000)).toThrow(
      'exceeded bounded module work'
    );
  });

  it('bounds a wide owner-consumer graph before enqueueing its frontier', () => {
    expect(() => inspectTopLevelOwnerConsumerBoundForTesting(150_000)).toThrow(
      'exceeded bounded candidate work'
    );
  });

  it('indexes reverse owner-consumer sources once', () => {
    expect(inspectArtifactOwnerConsumerSourcesForTesting(16_000)).toBe(16_000);
  });

  it.each([
    [
      'preserves the invoked second rest argument',
      'const sink=(first,second)=>second();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'does not collapse a dormant second rest argument onto the first',
      'const sink=effect=>effect();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      [],
    ],
    [
      'preserves positional rest identity through two wrappers',
      'const sink=(first,second)=>second();const inner=(...effects)=>sink(...effects);const outer=(...effects)=>inner(...effects);outer(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a canonical string index for the first rest argument',
      'const sink=(...values)=>values["0"]();const relay=(...effects)=>sink(...effects);relay(()=>fetch("https://invalid.example"),()=>undefined);',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a canonical string index for the second rest argument',
      'const sink=(...values)=>values["1"]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a static template index for the second rest argument',
      'const sink=(...values)=>values[`1`]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes an interpolated static template index for the second rest argument',
      'const sink=(...values)=>values[`${1}`]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a static arithmetic index for the second rest argument',
      'const sink=(...values)=>values[0+1]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a BigInt index for the first rest argument',
      'const sink=(...values)=>values[0n]();const relay=(...effects)=>sink(...effects);relay(()=>fetch("https://invalid.example"),()=>undefined);',
      ['fetch("https://invalid.example")'],
    ],
    [
      'normalizes a BigInt index for the second rest argument',
      'const sink=(...values)=>values[1n]();const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
      ['fetch("https://invalid.example")'],
    ],
  ])('%s', (_label, source, effects) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(effects);
  });

  it('rejects a runtime-computed rest parameter projection', () => {
    const source =
      'const sink=(key,...values)=>values[key]();const relay=(key,...effects)=>sink(key,...effects);relay(1,()=>undefined,()=>fetch("https://invalid.example"));';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects unbounded computed rest-parameter projections'
    );
  });

  it.each([
    ['const transform=(value)=>value;', []],
    ['const transform=(effect)=>effect();', [{ name: 'effect', path: [] }]],
    [
      'const transform=(value)=>value.map(String);',
      [{ name: 'value', path: ['map'] }],
    ],
  ])('classifies reviewed callable parameter use', (source, expected) => {
    expect(
      inspectCloudflareInvokedParameterProjectionsForTesting(
        source,
        'transform'
      )
    ).toEqual(expected);
  });

  it.each([
    [
      'rest array',
      'const sink=(key,...values)=>{const {[key]:effect}=values;effect()};const relay=(key,...effects)=>sink(key,...effects);relay(1,()=>undefined,()=>fetch("https://invalid.example"));',
    ],
    [
      'object',
      'const sink=(key,value)=>{const {[key]:effect}=value;effect()};sink("danger",{danger:()=>fetch("https://invalid.example")});',
    ],
  ])(
    'rejects a dynamic computed destructuring key on a %s',
    (_label, source) => {
      expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
        'requires static destructuring keys'
      );
    }
  );

  it.each([
    [
      'forwarded rest array',
      'const sink=(...values)=>{const [,effect]=values;effect()};const relay=(...effects)=>sink(...effects);relay(()=>undefined,()=>fetch("https://invalid.example"));',
    ],
    [
      'concrete array argument',
      'const sink=values=>{const [,effect]=values;effect()};sink([()=>undefined,()=>fetch("https://invalid.example")]);',
    ],
  ])('preserves local ArrayPattern position for a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'missing array element',
      'const sink=(...values)=>{const [,effect=()=>fetch("https://invalid.example")]=values;effect()};sink(()=>undefined);',
    ],
    [
      'explicitly undefined array element',
      'const sink=(...values)=>{const [,effect=()=>fetch("https://invalid.example")]=values;effect()};sink(()=>undefined,undefined);',
    ],
    [
      'missing object property',
      'const sink=values=>{const {effect=()=>fetch("https://invalid.example")}=values;effect()};sink({});',
    ],
    [
      'explicitly undefined object property',
      'const sink=values=>{const {effect=()=>fetch("https://invalid.example")}=values;effect()};sink({effect:undefined});',
    ],
    [
      'default through two wrappers',
      'const sink=(...values)=>{const [,effect=()=>fetch("https://invalid.example")]=values;effect()};const first=(...values)=>sink(...values);const second=(...values)=>first(...values);second(()=>undefined);',
    ],
  ])('applies a local destructuring default for a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    'const run=({effect}={effect:()=>fetch("https://invalid.example")})=>effect();run();',
    'const run=([effect]=[()=>fetch("https://invalid.example")])=>effect();run();',
  ])('projects a whole-pattern parameter default', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('does not apply a default to a shadowed undefined binding', () => {
    const source =
      'const undefined=()=>0;const [effect=()=>fetch("https://invalid.example")]=[undefined];effect();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'direct rest tail',
      'const sink=(...values)=>{const [first,...tail]=values;tail[0]()};sink(()=>undefined,()=>fetch("https://invalid.example"));',
    ],
    [
      'rest tail through two wrappers',
      'const sink=(...values)=>{const [first,...tail]=values;tail[0]()};const first=(...values)=>sink(...values);const second=(...values)=>first(...values);second(()=>undefined,()=>fetch("https://invalid.example"));',
    ],
  ])('preserves a local array %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'direct symbolic array spread',
      'const sink=path=>{const next=[...path];next[0]()};sink([()=>fetch("https://invalid.example")]);',
    ],
    [
      'symbolic array spread through a wrapper',
      'const sink=path=>{const next=[...path];next[0]()};const relay=path=>sink(path);relay([()=>fetch("https://invalid.example")]);',
    ],
  ])('fails closed for a callable %s', (_label, source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'statically analyzable aggregate spreads'
    );
  });

  it('allows an unresolved member array spread used only as data', () => {
    const source =
      'const normalize=(error,path=[])=>{for(const issue of error.issues){const next=[...path,...issue.path];if(next.length===0)return 0}return 1};';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('rejects an unresolved member array spread that reaches a call', () => {
    const source =
      'const run=source=>{const values=[...source.items];values[0]()};run(getUnknown());';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'statically analyzable aggregate spreads'
    );
  });

  it('rejects an unresolved array-producing call spread at load time', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting('const values=[...getUnknown()];')
    ).toThrow('statically analyzable aggregate spreads');
  });

  it('keeps an unresolved array-producing call spread dormant', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const dormant=()=>[...getUnknown()];'
      )
    ).toEqual([]);
  });

  it('propagates a callable through a parameter-backed for-of loop', () => {
    const source =
      'const run=values=>{for(const value of values)value()};run([()=>fetch("https://invalid.example")]);';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'tail index one through one wrapper',
      'const sink=(...values)=>{const [first,...tail]=values;tail[1]()};const relay=(...values)=>sink(...values);relay(()=>0,()=>0,()=>fetch("https://invalid.example"));',
    ],
    [
      'tail index three through two wrappers',
      'const sink=(...values)=>{const [first,...tail]=values;tail[3]()};const first=(...values)=>sink(...values);const second=(...values)=>first(...values);second(()=>0,()=>0,()=>0,()=>0,()=>fetch("https://invalid.example"));',
    ],
  ])('preserves a local array %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('resolves a static computed destructuring key', () => {
    const source =
      'const sink=(...values)=>{const {[`${1}`]:effect}=values;effect()};sink(()=>undefined,()=>fetch("https://invalid.example"));';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'direct object member assignment',
      'const target={run:()=>undefined};target.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'Object.assign member replacement',
      'const target={run:()=>undefined};Object.assign(target,{run:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'array index assignment',
      'const target=[];target[0]=()=>fetch("https://invalid.example");target[0]();',
    ],
    [
      'conditional member assignment',
      'const target={run:()=>undefined};if(flag)target.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('detects load effects from a prior %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('allows a prior safe member assignment', () => {
    const source =
      'const target={run:()=>undefined};target.run=()=>undefined;target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'write through alias',
      'const target={run:()=>0};const alias=target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'read through alias',
      'const target={run:()=>0};const alias=target;target.run=()=>fetch("https://invalid.example");alias.run();',
    ],
    [
      'chained alias',
      'const target={run:()=>0};const first=target;const second=first;second.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'destructured object alias',
      'const target={run:()=>0};const box={target};const {target:alias}=box;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'destructured array alias',
      'const target={run:()=>0};const box=[target];const [alias]=box;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('tracks a prior member mutation across a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'parameter alias',
      'const target={run:()=>0};function mutate(alias){alias.run=()=>fetch("https://invalid.example")}mutate(target);target.run();',
    ],
    [
      'rest parameter alias',
      'const target={run:()=>0};function mutate(...values){values[0].run=()=>fetch("https://invalid.example")}mutate(target);target.run();',
    ],
    [
      'opaque identity-call alias',
      'const target={run:()=>0};const identity=value=>value;const alias=identity(target);alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('conservatively tracks a mutation through a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('scopes a directly called parameter receiver mutation to its argument', () => {
    const source =
      'const first={run:()=>0};const second={run:()=>0};function mutate(target){target.run=()=>fetch("https://invalid.example")}mutate(first);second.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'propagates the projected receiver to the called argument',
      'class First{};function mutate(type){Object.defineProperty(type.prototype,"run",{value:()=>fetch("https://invalid.example")})}mutate(First);new First().run();',
      ['fetch("https://invalid.example")'],
    ],
    [
      'does not contaminate another projected receiver',
      'class First{};class Second{run(){}};function mutate(type){Object.defineProperty(type.prototype,"run",{value:()=>fetch("https://invalid.example")})}mutate(First);new Second().run();',
      [],
    ],
  ])('%s for a directly called parameter', (_label, source, effects) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual(effects);
  });

  it.each([
    [
      'Object.assign call-result alias',
      'const target={run:()=>0};const alias=Object.assign(target,{});alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'conditional alias',
      'const target={run:()=>0};const other={run:()=>0};const alias=flag?target:other;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'logical alias',
      'const target={run:()=>0};const other={run:()=>0};const alias=flag&&target||other;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('tracks a prior mutation through a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('conservatively retains receiver aliases across rebinding', () => {
    const source =
      'const target={run:()=>0};let alias=target;alias={run:()=>0};alias.run=()=>fetch("https://invalid.example");target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'direct invoked closure',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}mutate();target.run();',
    ],
    [
      'Object.assign in an invoked closure',
      'const target={run:()=>0};function mutate(){Object.assign(target,{run:()=>fetch("https://invalid.example")})}mutate();target.run();',
    ],
    [
      'transitively invoked closure',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}function wrapper(){mutate()}wrapper();target.run();',
    ],
  ])('tracks a mutation from a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'hoisted function declared after its call',
      'const target={run:()=>0};mutate();target.run();function mutate(){target.run=()=>fetch("https://invalid.example")}',
    ],
    [
      'aliased function',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}const alias=mutate;alias();target.run();',
    ],
    [
      'object-held function',
      'const target={run:()=>0};const funcs={mutate(){target.run=()=>fetch("https://invalid.example")}};funcs.mutate();target.run();',
    ],
    [
      'bound function',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}const alias=mutate.bind(null);alias();target.run();',
    ],
    [
      'sibling function',
      'const target={run:()=>0};mutate();read();function mutate(){target.run=()=>fetch("https://invalid.example")}function read(){target.run()}',
    ],
    [
      'transitive sibling function',
      'const target={run:()=>0};wrapper();function wrapper(){mutate();read()}function mutate(){target.run=()=>fetch("https://invalid.example")}function read(){target.run()}',
    ],
    [
      'program write before a nested read',
      'const target={run:()=>0};target.run=()=>fetch("https://invalid.example");read();function read(){target.run()}',
    ],
  ])('tracks a mutation from a prior %s call', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'aliased function invoked after the read',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}const alias=mutate;target.run();alias();',
    ],
    [
      'object-held function invoked after the read',
      'const target={run:()=>0};const funcs={mutate(){target.run=()=>fetch("https://invalid.example")}};target.run();funcs.mutate();',
    ],
    [
      'sibling function invoked after the read',
      'const target={run:()=>0};read();mutate();function mutate(){target.run=()=>fetch("https://invalid.example")}function read(){target.run()}',
    ],
    [
      'program write after a nested read',
      'const target={run:()=>0};read();target.run=()=>fetch("https://invalid.example");function read(){target.run()}',
    ],
  ])('ignores a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'dormant closure',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}target.run();',
    ],
    [
      'closure invoked after the read',
      'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}target.run();mutate();',
    ],
  ])('does not apply a mutation from a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'nested member receiver',
      'const box={target:{run:()=>0}};box.target.run=()=>fetch("https://invalid.example");box.target.run();',
    ],
    [
      'aliased nested member receiver',
      'const box={target:{run:()=>0}};const target=box.target;target.run=()=>fetch("https://invalid.example");box.target.run();',
    ],
    [
      'nested array receiver',
      'const box=[{run:()=>0}];box[0].run=()=>fetch("https://invalid.example");box[0].run();',
    ],
  ])('tracks a mutation on a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('rejects an unresolved computed structural mutation receiver', () => {
    const source =
      'const box={x:{run:()=>0}};box[key].run=()=>undefined;box.x.run();';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    [
      'source getter return',
      'const target={};Object.assign(target,{get run(){return()=>fetch("https://invalid.example")}});target.run();',
    ],
    [
      'target setter',
      'const target={set run(value){fetch("https://invalid.example")}};Object.assign(target,{run:1});',
    ],
    [
      'Function.prototype.call',
      'const target={};Object.assign.call(null,target,{run:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'Function.prototype.apply',
      'const target={};Object.assign.apply(null,[target,{run:()=>fetch("https://invalid.example")}]);target.run();',
    ],
    [
      'Reflect.apply',
      'const target={};Reflect.apply(Object.assign,null,[target,{run:()=>fetch("https://invalid.example")}]);target.run();',
    ],
  ])('models Object.assign %s semantics', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'named prototype getter',
      'const proto={get run(){return()=>fetch("https://invalid.example")}};const target=Object.create(proto);target.run();',
    ],
    [
      'transitive named prototype getter',
      'const root={get run(){return()=>fetch("https://invalid.example")}};const proto=Object.create(root);const target=Object.create(proto);target.run();',
    ],
    [
      'named prototype setter on assignment',
      'const proto={set run(value){fetch("https://invalid.example")}};const target=Object.create(proto);target.run=1;',
    ],
    [
      'named prototype setter through Object.assign',
      'const proto={set run(value){fetch("https://invalid.example")}};const target=Object.create(proto);Object.assign(target,{run:1});',
    ],
  ])('models an Object.create %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'Reflect.defineProperty data descriptor',
      'const target={};Reflect.defineProperty(target,"run",{value:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'Reflect.set',
      'const target={};Reflect.set(target,"run",()=>fetch("https://invalid.example"));target.run();',
    ],
  ])('models a supported %s mutation', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'aliased Object.defineProperty',
      'const target={};const define=Object.defineProperty;define(target,"run",{value:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'aliased Reflect.defineProperty',
      'const target={};const define=Reflect.defineProperty;define(target,"run",{value:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'Object.defineProperty.call',
      'const target={};Object.defineProperty.call(null,target,"run",{value:()=>fetch("https://invalid.example")});target.run();',
    ],
    [
      'Object.defineProperty.apply',
      'const target={};Object.defineProperty.apply(null,[target,"run",{value:()=>fetch("https://invalid.example")}]);target.run();',
    ],
    [
      'Reflect.apply Object.defineProperty',
      'const target={};Reflect.apply(Object.defineProperty,null,[target,"run",{value:()=>fetch("https://invalid.example")}]);target.run();',
    ],
  ])('models a normalized %s mutation', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('keeps a same-parameter defineProperty mutation precise', () => {
    const source =
      'const apply=inst=>{Object.defineProperty(inst,"run",{value:()=>fetch("https://invalid.example")});inst.run()};apply({});';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it.each([
    [
      'Object.defineProperties value descriptor',
      'const target={};Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    ],
    [
      'Object.defineProperties.call value descriptor',
      'const target={};Object.defineProperties.call(null,target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    ],
    [
      'Object.defineProperties getter descriptor',
      'const target={};Object.defineProperties(target,{run:{get:()=>()=>fetch("https://invalid.example")}});target.run();',
    ],
  ])('models a supported %s mutation', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={};Object.defineProperties(target,{run:{value:()=>undefined}});target.run();',
    'const target={};Object.defineProperties.call(null,target,{run:{value:()=>undefined}});target.run();',
    'const target={};const descriptors={run:{value:()=>undefined}};Object.defineProperties(target,descriptors);target.run();',
    'const target={};Object.defineProperties(target,{run:{get:undefined,set:()=>undefined}});void target.run;',
    'const target={};Object.defineProperties(target,{run:{get:void 0,set:()=>undefined}});void target.run;',
  ])('allows a safe %s mutation', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it.each([
    [
      'factory-produced descriptor map',
      'const map=run=>({run:{value:run}});const target={};Object.defineProperties(target,map(()=>fetch("https://invalid.example")));target.run();',
    ],
    [
      'nested factory-produced descriptor',
      'const descriptor=value=>({value});const map=run=>({run:descriptor(run)});const target={};Object.defineProperties(target,map(()=>fetch("https://invalid.example")));target.run();',
    ],
    [
      'prior descriptor-map mutation',
      'const descriptors={};descriptors.run={value:()=>fetch("https://invalid.example")};const target={};Object.defineProperties(target,descriptors);target.run();',
    ],
    [
      'prior descriptor mutation',
      'const descriptor={};descriptor.value=()=>fetch("https://invalid.example");const target={};Object.defineProperties(target,{run:descriptor});target.run();',
    ],
    [
      'immediate returned receiver',
      'Object.defineProperties({},{run:{value:()=>fetch("https://invalid.example")}}).run();',
    ],
    [
      'aliased returned receiver',
      'const target={};const result=Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example")}});result.run();',
    ],
    [
      'conditional receiver',
      'const first={};const second={};Object.defineProperties(flag?first:second,{run:{value:()=>fetch("https://invalid.example")}});first.run();',
    ],
  ])('preserves %s ownership', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={};Object.defineProperties(target,{run:{__proto__:{value:()=>fetch("https://invalid.example")}}});target.run();',
    'Object.prototype.value=()=>fetch("https://invalid.example");const target={};Object.defineProperties(target,{run:{}});target.run();',
    'const key=getKey();const target={};Object.defineProperties(target,{[key]:{value:()=>fetch("https://invalid.example")}});target[key]();',
    'const key=Symbol.for("run");const target={};Object.defineProperties(target,{[key]:{value:()=>fetch("https://invalid.example")}});target[key]();',
  ])('fails closed for ambiguous descriptor semantics', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it('uses last-property semantics for descriptor maps and descriptors', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example")},run:{value:()=>undefined}});target.run();'
      )
    ).toEqual([]);
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example"),value:()=>undefined}});target.run();'
      )
    ).toEqual([]);
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperties(target,{run:{value:()=>undefined,value:()=>fetch("https://invalid.example")}});target.run();'
      )
    ).toContain('fetch("https://invalid.example")');
  });

  it.each([
    'const target={};const define=Object.defineProperties;define(target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    'const target={};Object.defineProperties.apply(null,[target,{run:{value:()=>fetch("https://invalid.example")}}]);target.run();',
    'const target={};Reflect.apply(Object.defineProperties,null,[target,{run:{value:()=>fetch("https://invalid.example")}}]);target.run();',
    'const target={};const define=Object.defineProperties.bind(null);define(target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    'const target={};globalThis.Object.defineProperties(target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
    'const target={};Object["defineProperties"](target,{run:{value:()=>fetch("https://invalid.example")}});target.run();',
  ])('normalizes a defineProperties invocation form', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('executes a defineProperties getter when its member is read', () => {
    expect(
      inspectCloudflareLoadEffectsForTesting(
        'const target={};Object.defineProperties(target,{run:{get:()=>{fetch("https://invalid.example");return 1}}});void target.run;'
      )
    ).toContain('fetch("https://invalid.example")');
  });

  it('indexes statically named defineProperties mutations by member', () => {
    const writes = Array.from(
      { length: 256 },
      (_unused, index) =>
        `Object.defineProperties(target,{member${String(index)}:{value:()=>undefined}})`
    ).join(';');
    const reads = Array.from(
      { length: 256 },
      (_unused, index) => `target.member${String(index)}()`
    ).join(';');

    expect(
      inspectCloudflareLoadEffectsForTesting(
        `const target={};${writes};${reads};`
      )
    ).toEqual([]);
  });

  it.each([
    [
      'local object method',
      'const target={run:()=>0};function wrapper(){const api={mutate(){target.run=()=>fetch("https://invalid.example")}};api.mutate()}wrapper();target.run();',
    ],
    [
      'local class method',
      'const target={run:()=>0};function wrapper(){class API{mutate(){target.run=()=>fetch("https://invalid.example")}};new API().mutate()}wrapper();target.run();',
    ],
  ])('orders a mutation performed by an active %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'call result',
      'const target={run:()=>0};const get=()=>target;get().run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'conditional',
      'const target={run:()=>0};const other={run:()=>0};(flag?target:other).run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'array projection',
      'const target={run:()=>0};[target][0].run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'object projection',
      'const target={run:()=>0};({target}).target.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('tracks a %s mutation receiver', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'object spread',
      'const target={run:()=>0};const box={...{target}};const alias=box.target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'array spread',
      'const target={run:()=>0};const box=[...[target]];const alias=box[0];alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'Object.assign container',
      'const target={run:()=>0};const box=Object.assign({},{target});const alias=box.target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'object rest',
      'const target={run:()=>0};const source={target};const {...rest}=source;const alias=rest.target;alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
    [
      'array rest',
      'const target={run:()=>0};const source=[target];const [...rest]=source;const alias=rest[0];alias.run=()=>fetch("https://invalid.example");target.run();',
    ],
  ])('does not lose a nested alias through %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    [
      'Object.defineProperty',
      'const target={run:()=>0};function mutate(){const define=Object.defineProperty;define(target,"run",{value:()=>fetch("https://invalid.example")})}mutate();target.run();',
    ],
    [
      'Object.defineProperties',
      'const target={run:()=>0};function mutate(){const define=Object.defineProperties;define(target,{run:{value:()=>fetch("https://invalid.example")}})}mutate();target.run();',
    ],
    [
      'Object.assign',
      'const target={run:()=>0};function mutate(){const assign=Object.assign;assign(target,{run:()=>fetch("https://invalid.example")})}mutate();target.run();',
    ],
  ])('normalizes a function-local %s alias', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it('fails closed for a function-local legacy getter alias', () => {
    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        'const target={run:()=>0};function mutate(){const getter=target.__defineGetter__;getter("run",()=>()=>fetch("https://invalid.example"))}mutate();target.run();'
      )
    ).toThrow('rejects opaque aggregate member mutations');
  });

  it.each([
    'Reflect.get(globalThis,"fetch")("https://invalid.example")',
    'Object.getOwnPropertyDescriptor(globalThis,"fetch").value("https://invalid.example")',
    'const get=Reflect.get;get(globalThis,"fetch")("https://invalid.example")',
    'const descriptor=Object.getOwnPropertyDescriptor(globalThis,"fetch");descriptor.value("https://invalid.example")',
  ])('detects a reflective load-effect read', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toEqual([]);
  });

  it.each([
    'const target={};const descriptors=getDescriptors();Object.defineProperties(target,descriptors);target.run();',
    'const target={};const extra=getDescriptors();Object.defineProperties(target,{...extra});target.run();',
    'const target={};const descriptor=getDescriptor();Object.defineProperties(target,{run:descriptor});target.run();',
  ])('rejects an opaque Object.defineProperties mutation', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    'const target={};Object.setPrototypeOf(target,{run:()=>undefined});target.run();',
    'const target={};Reflect.setPrototypeOf(target,{run:()=>undefined});target.run();',
    'const target={};Object.setPrototypeOf.call(null,target,{run:()=>undefined});target.run();',
    'const target={};Reflect.apply(Object.setPrototypeOf,null,[target,{run:()=>undefined}]);target.run();',
    'const target={};target.__proto__={run:()=>undefined};target.run();',
    'const target={};target.__defineGetter__("run",()=>()=>undefined);target.run();',
    'const target={};const define=target.__defineGetter__;define("run",()=>()=>undefined);target.run();',
  ])('rejects an unsupported aggregate mutation family', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it('indexes a wide set of irrelevant member mutations without quadratic scans', () => {
    const writes = Array.from(
      { length: 4_096 },
      (_unused, index) => `target["member${String(index)}"]=()=>undefined`
    ).join(';');

    expect(
      inspectCloudflareLoadEffectsForTesting(
        `const target={run:()=>undefined};${writes};target.run();`
      )
    ).toEqual([]);
  });

  it('bounds a wide member-mutation and read workload', () => {
    const writes = Array.from(
      { length: 4_096 },
      (_unused, index) => `target["member${String(index)}"]=()=>undefined`
    ).join(';');
    const reads = Array.from(
      { length: 4_096 },
      (_unused, index) => `target["member${String(index)}"]()`
    ).join(';');

    expect(() =>
      inspectCloudflareLoadEffectsForTesting(
        `const target={};${writes};${reads};`
      )
    ).toThrow('exceeded bounded candidate work');
  });

  it.each([
    [
      'dormant function',
      'const target={run:()=>undefined};function dormant(){target.run=()=>fetch("https://invalid.example")}target.run();',
    ],
    [
      'shadowed receiver',
      'const target={run:()=>undefined};function dormant(target){target.run=()=>fetch("https://invalid.example")}target.run();',
    ],
  ])('isolates member mutations in a %s', (_label, source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('models a dynamic member write as a wildcard mutation', () => {
    const source =
      'const target={run:()=>undefined};target[key]=()=>fetch("https://invalid.example");target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([
      'fetch("https://invalid.example")',
    ]);
  });

  it('allows a safe dynamic member write', () => {
    const source =
      'const target={run:()=>undefined};target[key]=()=>undefined;target.run();';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('keeps a recursive dynamic aggregate cursor locally scoped', () => {
    const source =
      'const walk=path=>{const root={_errors:[]};let curr=root;let i=0;while(i<path.length){const key=path[i];curr[key]=curr[key]||{_errors:[]};curr[key]._errors.push(()=>0);curr=curr[key];i++}};walk(["x"]);';

    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([]);
  });

  it('rejects an opaque prior member mutation', () => {
    const source =
      'const target={run:()=>undefined};Object.defineProperty(target,"run",{get(){return()=>undefined}});target.run();';

    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'rejects opaque aggregate member mutations'
    );
  });

  it.each([
    [
      'Object.assign aggregate replacement',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box={route};Object.assign(box,{route:({loader})=>loader()});box.route({loader:()=>fetch("https://invalid.example")});',
      false,
      ['box', 'createFileRoute', 'route'],
    ],
    [
      'direct aggregate member replacement',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box={route};box.route=({loader})=>loader();box.route({loader:()=>fetch("https://invalid.example")});',
      false,
      ['box', 'createFileRoute', 'route'],
    ],
    [
      'unrelated sibling mutation',
      'import{createFileRoute}from"./reviewed.js";const first=createFileRoute("/a");const second=createFileRoute("/b");Object.assign(first,{metadata:true});second({loader:()=>1});',
      true,
      ['createFileRoute', 'second'],
    ],
    [
      'nested parameter shadow mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");function dormant(route){route.metadata=true}route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'unrelated closure capture mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const describe=()=>route;Object.assign(describe,{metadata:true});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'unrelated receiver member mutation',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const alias=route.metadata;Object.assign(alias,{x:1});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'statically unreachable conditional container',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box=false?{route}:{};Object.assign(box,{route:()=>1});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'statically unreachable logical-and container',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box=false&&{route};Object.assign(box,{route:()=>1});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
    [
      'statically unreachable logical-or container',
      'import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");const box=true||{route};Object.assign(box,{route:()=>1});route({loader:()=>1});',
      true,
      ['createFileRoute', 'route'],
    ],
  ])(
    'tracks reviewed receiver mutations for %s',
    (_label, source, unmutated, roots) => {
      const [state] =
        inspectCloudflareReviewedReceiverMutationsForTesting(source);

      expect(state).toEqual({
        callee: expect.any(String),
        roots,
        unmutated,
      });
    }
  );

  it('indexes reverse-ordered reviewed receiver aliases once', () => {
    const aliasCount = 4_096;
    const dependencies = [
      'route',
      ...Array.from(
        { length: aliasCount - 1 },
        (_unused, index) => `alias${index}`
      ),
    ];
    const aliases = Array.from({ length: aliasCount }, (_unused, index) => {
      const current = aliasCount - index - 1;
      const dependency = dependencies[current];
      return `const alias${current}={${dependency}};`;
    }).join('');
    const [state] = inspectCloudflareReviewedReceiverMutationsForTesting(
      `import{createFileRoute}from"./reviewed.js";const route=createFileRoute("/x");${aliases}Object.assign(alias${aliasCount - 1},{changed:true});route({loader:()=>1});`
    );

    expect(state.unmutated).toBe(false);
    expect(state.roots).toHaveLength(aliasCount + 2);
    expect(state.roots).toContain(`alias${aliasCount - 1}`);
  }, 10_000);

  it('reuses reviewed receiver indexes across many invocations', () => {
    const routeCount = 800;
    const routes = Array.from(
      { length: routeCount },
      (_unused, index) =>
        `const route${index}=createFileRoute("/${index}");route${index}({loader:()=>${index}});`
    ).join('');
    const states = inspectCloudflareReviewedReceiverMutationsForTesting(
      `import{createFileRoute}from"./reviewed.js";${routes}`
    );

    expect(states).toHaveLength(routeCount);
    expect(states.every(({ unmutated }) => unmutated)).toBe(true);
  }, 5_000);

  it('accepts each exact target artifact contract', () => {
    const root = fixture();
    createNodeArtifact(root);
    createVercelArtifact(root);
    createCloudflareArtifact(root);

    expect(verifyRuntimeProfile('node', root)).toBe('node');
    expect(verifyRuntimeProfile('vercel', root)).toBe('vercel');
    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  });

  it('drains a long cyclic Cloudflare load-effect graph without recursive stack growth', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareLoadEffectCycle(root, 1_024);

    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  }, 30_000);

  it.each([
    ['missing key', (envelope) => envelope, ''],
    [
      'altered signature',
      (envelope) => ({ ...envelope, signature: 'A'.repeat(43) }),
      fixtureCloudflareProvenanceKey,
    ],
    [
      'unsigned envelope',
      (envelope) => ({ ...envelope, algorithm: 'none', signature: null }),
      fixtureCloudflareProvenanceKey,
    ],
  ])('rejects %s for app-owned build provenance', (_label, mutate, key) => {
    const root = fixture();
    createCloudflareArtifact(root);
    writeFixtureCloudflareProvenance(root);
    const provenancePath = path.join(
      root,
      'dist/server/start-ui-app-chunk-provenance.json'
    );
    const envelope = JSON.parse(fs.readFileSync(provenancePath, 'utf8'));
    writeJson(
      root,
      'dist/server/start-ui-app-chunk-provenance.json',
      mutate(envelope)
    );

    expect(() =>
      verifyRuntimeProfileImplementation('cloudflare', root, {
        cloudflareAppChunkProvenanceKey: key,
        cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare app-owned provenance authentication');
  });

  it.each([
    [
      'modified JavaScript bytes',
      (root) =>
        fs.appendFileSync(
          path.join(root, 'dist/server/assets/tags-fixture.js'),
          '\nconst postSignTamper=true;'
        ),
      'must have trusted app-owned build provenance',
    ],
    [
      'an unrecorded JavaScript file',
      (root) => write(root, 'dist/server/assets/post-sign-extra.js', ''),
      'Cloudflare app-owned provenance coverage',
    ],
    [
      'a removed recorded JavaScript file',
      (root) =>
        fs.rmSync(path.join(root, 'dist/server/assets/tags-fixture.js')),
      'tags-fixture.js',
    ],
  ])('rejects %s after provenance signing', (_label, tamper, message) => {
    const root = fixture();
    createCloudflareArtifact(root);
    writeFixtureCloudflareProvenance(root);
    tamper(root);

    expect(() =>
      verifyRuntimeProfileImplementation('cloudflare', root, {
        cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
        cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(message);
  });

  it('rejects a freshly signed JavaScript file missing from the Vite manifest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/assets/unmanifested-signed.js', '');
    writeFixtureCloudflareProvenance(root, {
      registerDetachedJavaScript: false,
    });

    expect(() =>
      verifyRuntimeProfileImplementation('cloudflare', root, {
        cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
        cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('unmanifested assets/unmanifested-signed.js');
  });

  it('rejects duplicate Vite manifest aliases for one JavaScript output', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_client-duplicate-fixture.js'] = {
      ...manifest['_client-fixture.js'],
    };
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must map one record to each JavaScript output');
  });

  it.each([
    ['dangling', ['_missing-fixture.js']],
    ['duplicate', ['_client-fixture.js', '_client-fixture.js']],
  ])('rejects %s Vite manifest edges', (_label, imports) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_backend-fixture.js'].imports = imports;
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare app-owned manifest graph');
  });

  it('parses the exact JavaScript bytes authenticated by provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/client-fixture.js';
    const filePath = path.join(root, relativePath);
    const safeSource = fs.readFileSync(filePath, 'utf8');
    write(root, relativePath, `fetch("https://invalid.example");${safeSource}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/authenticated-client.ts',
    ]);
    writeFixtureCloudflareProvenance(root);
    const readFile = fs.readFileSync.bind(fs);
    const readSpy = vi
      .spyOn(fs, 'readFileSync')
      .mockImplementation((candidate, options) =>
        readFixtureSourceOverride(
          readFile,
          filePath,
          safeSource,
          candidate,
          options
        )
      );

    try {
      expect(() =>
        verifyRuntimeProfileImplementation('cloudflare', root, {
          cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
          cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    } finally {
      readSpy.mockRestore();
    }
  });

  it('rejects a symlinked Cloudflare output root', () => {
    const root = fixture();
    const external = fixture();
    createCloudflareArtifact(external);
    write(
      root,
      'wrangler.json',
      fs.readFileSync(path.join(external, 'wrangler.json'), 'utf8')
    );
    fs.symlinkSync(path.join(external, 'dist'), path.join(root, 'dist'), 'dir');

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must be a regular artifact directory');
  });

  it('accepts merged Sentry request-state declarations', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'let applicationOutcome;let applicationWork;',
          'let applicationOutcome,applicationWork;'
        )
    );

    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  });

  it('accepts merged request-telemetry adapter declarations', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-telemetry-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const sentryOptions=createCloudflareSentryOptions(sentry,request,environment);const sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});',
          'const sentryOptions=createCloudflareSentryOptions(sentry,request,environment),sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});'
        )
    );

    expect(
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toBe('cloudflare');
  });

  it('rejects an expression-bodied Sentry request owner cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const runWithCloudflareSentry=.*?;export\{initializeCloudflareSentryApplication/u,
          'const runWithCloudflareSentry=async({api,handle,request,requestOptions})=>(Error,Promise,Response,api.withScope,api.wrapRequestHandler,handle());export{initializeCloudflareSentryApplication'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own its bounded request body');
  });

  it.each([
    [
      'database response owner',
      'dist/server/assets/database-request-fixture.js',
      '({database,request,response})=>',
      '({database,request,response},leak=exfiltrate(request,response))=>',
      'database response owner must accept exact active inputs',
    ],
    [
      'request telemetry owner',
      'dist/server/assets/request-telemetry-fixture.js',
      '({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>',
      '({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady},leak=exfiltrate(request))=>',
      'request telemetry owner must accept exact active inputs',
    ],
    [
      'Sentry request owner',
      'dist/server/assets/sentry-request-fixture.js',
      'async({api,handle,request,requestOptions})=>',
      'async({api,handle,request,requestOptions},leak=exfiltrate(request))=>',
      'Sentry request owner must accept exact active request inputs',
    ],
    [
      'application execution owner',
      'dist/server/assets/sentry-request-fixture.js',
      'const runApplicationOnce=()=>',
      'const runApplicationOnce=(leak=exfiltrate(request))=>',
      'Sentry request runner must own one parameterless execution body',
    ],
  ])(
    'rejects a side-effecting extra parameter on the %s',
    (_label, relativePath, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it.each([
    ['mixed', ['src/runtime/cloudflare/reviewed-load-owner.ts', 'non-app:pkg']],
    ['non-app', undefined],
  ])('deep-scans an unreviewed %s static chunk', (_ownership, modules) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const trustedFile = 'client-fixture.js';
    const substitutedFile = 'client-unreviewed-fixture.js';
    const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
    write(
      root,
      `dist/server/assets/${substitutedFile}`,
      `(function(){fetch("https://invalid.example")})();${fs.readFileSync(
        trustedPath,
        'utf8'
      )}`
    );
    const ownerPath = 'dist/server/assets/database-request-fixture.js';
    const ownerFile = path.join(root, ownerPath);
    write(
      root,
      ownerPath,
      fs.readFileSync(ownerFile, 'utf8').replace(trustedFile, substitutedFile)
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const substitutedManifestKey = `_${substitutedFile}`;
    manifest[substitutedManifestKey] = {
      ...manifest['_client-fixture.js'],
      file: `assets/${substitutedFile}`,
    };
    const ownerImports =
      manifest['src/runtime/cloudflare/database-request.ts'].imports;
    ownerImports.splice(
      ownerImports.indexOf('_client-fixture.js'),
      1,
      substitutedManifestKey
    );
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markOptionalFixtureAppOwnedChunk(
      root,
      `assets/${substitutedFile}`,
      modules
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    'const run=(fetch)=>fetch();run(()=>undefined);',
    'const run=(effect=()=>fetch("https://invalid.example"))=>effect();run(()=>undefined);',
    'const run=({unused,effect})=>effect();run({unused:()=>fetch("https://invalid.example"),effect:()=>undefined});',
    'const run=(...effects)=>effects[0]();run(()=>undefined,()=>fetch("https://invalid.example"));',
    'const runner={call(effect){return undefined}};runner.call(()=>fetch("https://invalid.example"));',
    'const run=effect=>effect();const args=[()=>undefined];run(...args);',
    'const run=(object,key)=>object[key]();run({safe:()=>undefined},"safe");',
    'const runner={call(effect){return undefined}};const key="call";runner[key](()=>fetch("https://invalid.example"));',
    'const dormant=(effect)=>{const alias=effect;alias()};const unused=()=>dormant(()=>fetch("https://invalid.example"));',
    'const runner={};Object.defineProperty(runner,"run",{value:()=>fetch("https://invalid.example")});',
    'function* dormant(){fetch("https://invalid.example")}dormant();',
  ])('does not activate a dormant or shadowed load effect (%s)', (prefix) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/safe-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    'const run=({effect})=>effect();run({...{effect:()=>fetch("https://invalid.example")}});',
    'const run=([effect])=>effect();run([...[()=>fetch("https://invalid.example")]]);',
    'const runner={...{run:()=>fetch("https://invalid.example")}};runner.run();',
    'const run=({safe,...rest})=>rest.effect();run({...{safe:true,effect:()=>fetch("https://invalid.example")}});',
    'const left=()=>undefined,right=()=>fetch("https://invalid.example");(false?left:right)();',
    'const left=()=>undefined,right=()=>fetch("https://invalid.example");(left||right)();',
    'const evil=()=>fetch("https://invalid.example"),get=()=>evil;get()();',
    'const get=value=>value;get(()=>fetch("https://invalid.example"))();',
    'const make=effect=>()=>effect();make(()=>fetch("https://invalid.example"))();',
    'const make=effect=>({run:effect});make(()=>fetch("https://invalid.example")).run();',
    'const make=effect=>[effect];make(()=>fetch("https://invalid.example"))[0]();',
    'const make=options=>()=>options.effect();make({effect:()=>fetch("https://invalid.example")})();',
    'const run=({effect})=>effect();run({effect:()=>undefined,...{effect:()=>fetch("https://invalid.example")}});',
    'const run=({effect})=>effect();run({effect:()=>undefined,effect:()=>fetch("https://invalid.example")});',
    'class Runner{constructor(effect){effect()}}new Runner(()=>fetch("https://invalid.example"));',
    'const Runner=class{constructor(effect){effect()}};new Runner(()=>fetch("https://invalid.example"));',
    'class Runner{constructor(){this.run()}run(){fetch("https://invalid.example")}}new Runner();',
    'class Base{constructor(){fetch("https://invalid.example")}}class Child extends Base{}new Child();',
    'class Base{constructor(){fetch("https://invalid.example")}}class Child extends Base{constructor(){super()}}new Child();',
    'class Runner{effect=fetch("https://invalid.example")}new Runner();',
    'const make=effect=>()=>effect();const evil=make(()=>fetch("https://invalid.example"));evil();',
    'const make=effect=>()=>()=>effect();make(()=>fetch("https://invalid.example"))()();',
    'const make=effect=>({run:effect}),evil=make(()=>fetch("https://invalid.example"));evil.run();',
    'const make=effect=>[effect],evil=make(()=>fetch("https://invalid.example"));evil[0]();',
    'const evil=()=>fetch("https://invalid.example");const{run}={run:evil};run();',
    'const evil=()=>fetch("https://invalid.example");const[run]=[evil];run();',
    'let run;run=()=>fetch("https://invalid.example");run();',
    'let run=()=>undefined;run=()=>fetch("https://invalid.example");run();',
    'let run;({run}={run:()=>fetch("https://invalid.example")});run();',
    'class Runner{static run(){fetch("https://invalid.example")}}Runner.run();',
    'class Runner{run(){fetch("https://invalid.example")}}new Runner().run();',
    'class Base{run(){fetch("https://invalid.example")}}class Child extends Base{constructor(){super();this.run()}}new Child();',
    'class Runner{effect=()=>fetch("https://invalid.example");constructor(){this.effect()}}new Runner();',
    'const deeper=y=>()=>y(),wrap=x=>()=>x();wrap(deeper(()=>fetch("https://invalid.example")))()();',
    'const deeper=y=>()=>y(),wrap=x=>()=>x(),outer=z=>()=>z();outer(wrap(deeper(()=>fetch("https://invalid.example"))))()()();',
    'const make=async()=>()=>fetch("https://invalid.example");(await make())();',
    'const make=async()=>({run:()=>fetch("https://invalid.example")});(await make()).run();',
    'const make=async()=>()=>fetch("https://invalid.example"),evil=await make();evil();',
    'function Factory(){return()=>fetch("https://invalid.example")}(new Factory())();',
    'class Factory{constructor(){return()=>fetch("https://invalid.example")}}new Factory()();',
    'function Factory(){return{run:()=>fetch("https://invalid.example")}}new Factory().run();',
    'class Evil{run(){fetch("https://invalid.example")}}function Factory(){return new Evil()}new Factory().run();',
    'function Factory(){return Object.create({run:()=>fetch("https://invalid.example")})}new Factory().run();',
    'function Factory(){this.run=()=>fetch("https://invalid.example")}new Factory().run();',
    'const tag=()=>()=>fetch("https://invalid.example");tag``();',
    'const tag=()=>({run:()=>fetch("https://invalid.example")});tag``.run();',
    'const tag=(strings,effect)=>()=>effect();tag`${()=>fetch("https://invalid.example")}`();',
    'let evil;(evil=()=>fetch("https://invalid.example"))();',
    'let value;(value={run:()=>fetch("https://invalid.example")}).run();',
    'let evil;evil??=()=>fetch("https://invalid.example");evil();',
    'function* make(){yield()=>fetch("https://invalid.example")}const evil=make().next().value;evil();',
    'function* make(){yield()=>fetch("https://invalid.example")}const iterator=make(),evil=iterator.next().value;evil();',
    'function* make(){yield()=>fetch("https://invalid.example")}const{value}=make().next();value();',
    'const runner={get run(){return()=>fetch("https://invalid.example")}};runner.run();',
    'const runner={get task(){return{run:()=>fetch("https://invalid.example")}}};runner.task.run();',
    'const runner={get effect(){fetch("https://invalid.example");return 1}},effect=runner.effect;',
    'class Runner{static get run(){return()=>fetch("https://invalid.example")}}Runner.run();',
    'class Runner{get task(){return{run:()=>fetch("https://invalid.example")}}}new Runner().task.run();',
    'class Runner{get effect(){fetch("https://invalid.example");return 1}}const runner=new Runner(),effect=runner.effect;',
    'const runner={set effect(value){fetch("https://invalid.example")}};runner.effect=1;',
    'class Runner{set effect(value){fetch("https://invalid.example")}}new Runner().effect=1;',
    'const source={get effect(){fetch("https://invalid.example");return 1}};Object.assign({},source);',
    'const runner={set effect(value){fetch("https://invalid.example")}};Reflect.set(runner,"effect",1);',
    'function* make(){return()=>fetch("https://invalid.example")}make().next().value();',
    'function* make(){yield()=>undefined;return()=>fetch("https://invalid.example")}const iterator=make();iterator.next();iterator.next().value();',
    'function* inner(){return()=>fetch("https://invalid.example")}function* outer(){return yield* inner()}outer().next().value();',
    'function* make(){yield()=>fetch("https://invalid.example")}const[evil]=make();evil();',
    'function* make(){yield()=>fetch("https://invalid.example")}for(const evil of make()){evil()}',
    `(()=>{}).constructor('return fetch("https://invalid.example")')();`,
    `({}).toString.constructor('return fetch("https://invalid.example")')();`,
    `(function*(){}).constructor('yield fetch("https://invalid.example")')().next();`,
    `Reflect.construct(Function,['return fetch("https://invalid.example")'])();`,
    'function Factory(){this.run=()=>fetch("https://invalid.example");return()=>this.run()}new Factory()();',
    'const runner={tag(){return()=>this.run()},run(){fetch("https://invalid.example")}};runner.tag``();',
    'function Factory(){return()=>fetch("https://invalid.example")}const run=Reflect.construct(Factory,[]);run();',
    'const Factory=new Proxy(function(){},{construct(){return()=>fetch("https://invalid.example")}});new Factory()();',
    'class Base{constructor(){return()=>fetch("https://invalid.example")}}class Child extends Base{}new Child()();',
    'class Base{constructor(){return()=>fetch("https://invalid.example")}}class Child extends Base{constructor(){super()}}new Child()();',
    'class Base{effect=fetch("https://invalid.example")}class Child extends Base{}new Child();',
    'class Dormant{[fetch("https://invalid.example")]=1}',
    'const source={get effect(){fetch("https://invalid.example");return 1}};const{effect}=source;',
    'const source={get effect(){fetch("https://invalid.example");return 1}},run=({effect})=>1;run(source);',
    'const factory=strategy=>arg=>strategy(arg),ignore=arg=>undefined,invoke=arg=>arg();factory(ignore)(()=>undefined);factory(invoke)(()=>fetch("https://invalid.example"));',
    'const factory=strategy=>arg=>strategy(arg),ignore=arg=>undefined,invoke=arg=>arg();factory(invoke)(()=>fetch("https://invalid.example"));factory(ignore)(()=>undefined);',
  ])('rejects a statically reachable aliased load effect (%s)', (prefix) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/aliased-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('keeps safe aggregate spread siblings dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const run=({effect})=>effect();const dormant=()=>fetch("https://invalid.example");run({...{dormant},...{effect:()=>undefined}});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/safe-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('bounds shared-DAG wildcard projection work', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const aggregateOwners = [
      'const leaf=()=>undefined;',
      'const a0=[leaf,leaf,leaf,leaf];',
      ...Array.from(
        { length: 9 },
        (_, index) =>
          `const a${index + 1}=[a${index},a${index},a${index},a${index}];`
      ),
    ].join('');
    const wildcardPath = Array.from(
      { length: 10 },
      (_, index) => `const k${index}=getKey();`
    ).join('');
    const memberPath = Array.from(
      { length: 10 },
      (_, index) => `[k${index}]`
    ).join('');
    const prefix = `${aggregateOwners}${wildcardPath}const run=value=>value${memberPath}();run(a9);`;
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/bounded-wildcard-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('exceeded bounded candidate work');
  });

  it('keeps an unconstructed instance field dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'class Runner{effect=fetch("https://invalid.example")}const dormant=Runner;';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/dormant-class-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    'const run=({effect})=>effect();run({effect:()=>fetch("https://invalid.example"),...{effect:()=>undefined}});',
    'const run=({effect})=>effect();run({effect:()=>fetch("https://invalid.example"),effect:()=>undefined});',
  ])('uses the final object property value (%s)', (prefix) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/final-property-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects a getter executed by object spread', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const source={get effect(){fetch("https://invalid.example");return 1}},target={...source};';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/getter-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('rejects accessor properties in aggregate spreads');
  });

  it('keeps an opaque object spread in an uncalled function dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const prepare=fields=>({...fields.telemetryExtras,ready:true});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/dormant-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('allows a discarded Proxy whose traps cannot be observed', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'new Proxy({}, {get(){fetch("https://invalid.example");return 1}});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/discarded-proxy-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps function values copied by native Object.assign dormant', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const target=Object.assign({}, {effect:()=>fetch("https://invalid.example")});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/native-object-assign-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('does not grant native Object.assign semantics to a shadowed binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const Object={assign:(target,source)=>source.effect()};Object.assign({}, {effect:()=>fetch("https://invalid.example")});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/shadowed-object-assign-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rejects a directly observed Proxy get trap', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const source=new Proxy({}, {get(){fetch("https://invalid.example");return 1}}),effect=source.effect;';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/observed-proxy-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    'const source=new Proxy({x:1},{get(target,key){fetch("https://invalid.example");return target[key]}}),target={...source};',
    'const source={};Object.defineProperty(source,"effect",{enumerable:true,get(){fetch("https://invalid.example");return 1}});const target={...source};',
    'const source=getOptions(),target={...source};',
  ])(
    'fails closed for a dynamically accessor-backed object spread (%s)',
    (prefix) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const clientFile = 'dist/server/assets/client-fixture.js';
      const clientPath = path.join(root, clientFile);
      write(
        root,
        clientFile,
        `${prefix}${fs.readFileSync(clientPath, 'utf8')}`
      );
      markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
        'src/platform/dynamic-spread-client.ts',
      ]);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        /(?:requires statically analyzable aggregate spreads|must not execute fetch, eval, or worker effects while loading)/u
      );
    }
  );

  it('rejects an opaque aggregate spread', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const source=getOptions(),run=({effect})=>effect();run({...source});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/opaque-aggregate-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    'const run=value=>{value.effect();run(value.next)};run({effect:()=>undefined,next:{}});',
    'const first=value=>{value.effect();second(value.next)},second=value=>first(value.next);first({effect:()=>undefined,next:{}});',
  ])('bounds recursive parameter projection analysis (%s)', (prefix) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/recursive-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('exceeded bounded parameter projection depth');
  });

  it('bounds recursive factory resolution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const choose=()=>globalThis.FLAG?choose():fetch;choose()("https://invalid.example");';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/recursive-factory-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('exceeded bounded factory resolution');
  });

  it('bounds branching recursive parameter projections by count', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const run=value=>{value.effect();run(value.a);run(value.b)};run({effect:()=>undefined,a:{},b:{}});';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/branching-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('exceeded bounded parameter projection count');
  });

  it('rejects an opaque spread passed to an invoked local function', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    write(
      root,
      clientFile,
      `const run=effect=>effect();const args=getArguments();run(...args);${fs.readFileSync(clientPath, 'utf8')}`
    );
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/opaque-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable spread arguments');
  });

  it.each([
    [
      'request telemetry owner',
      'dist/server/assets/request-telemetry-fixture.js',
      /const configureCloudflareRequestTelemetry=.*?;export\{configureCloudflareRequestTelemetry/u,
      'const configureCloudflareRequestTelemetry=({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>(setTelemetry(nativeTelemetry),createCloudflareSentryOptions(sentry,request,environment),{});export{configureCloudflareRequestTelemetry',
      'request telemetry owner must own its configuration body',
    ],
    [
      'Sentry application owner',
      'dist/server/assets/sentry-request-fixture.js',
      /const initializeCloudflareSentryApplication=.*?;const runWithCloudflareSentry/u,
      'const initializeCloudflareSentryApplication=async(api,loadApplication)=>initializeCloudflareSentryIsolation(api);const runWithCloudflareSentry',
      'Sentry application owner must own its initialization body',
    ],
    [
      'application runner',
      'dist/server/assets/sentry-request-fixture.js',
      /const runApplicationOnce=.*?;try\{/u,
      'const runApplicationOnce=()=>(Promise,applicationWork);try{',
      'Sentry request runner must own one parameterless execution body',
    ],
  ])(
    'rejects an expression-bodied %s cleanly',
    (_label, relativePath, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it.each([
    [
      'a duplicate fetch property',
      (source) =>
        source.replace(
          '}};export{worker_entry_default as default};',
          '},fetch:()=>new Response("bypassed")};export{worker_entry_default as default};'
        ),
      'must not contain duplicate properties',
    ],
    [
      'a spread fetch override',
      (source) =>
        source.replace(
          '}};export{worker_entry_default as default};',
          '},...{fetch:()=>new Response("bypassed")}};export{worker_entry_default as default};'
        ),
      'must not contain spread properties',
    ],
    [
      'a later Worker owner redeclaration',
      (source) =>
        source.replace(
          ';export{worker_entry_default as default};',
          ';var worker_entry_default={fetch:()=>new Response("bypassed")};export{worker_entry_default as default};'
        ),
      'must export one default Worker object',
    ],
    [
      'a later Worker object assignment',
      (source) =>
        source.replace(
          ';export{worker_entry_default as default};',
          ';worker_entry_default={fetch:()=>new Response("bypassed")};export{worker_entry_default as default};'
        ),
      'must not mutate or alias the default Worker object',
    ],
    [
      'a call-based Worker fetch mutation',
      (source) =>
        source.replace(
          ';export{worker_entry_default as default};',
          ';Object.assign(worker_entry_default,{fetch:()=>new Response("bypassed")});export{worker_entry_default as default};'
        ),
      'must not mutate or alias the default Worker object',
    ],
    [
      'a re-exported default Worker decoy',
      (source) =>
        source.replace(
          'export{worker_entry_default as default};',
          'export{worker_entry_default as default}from"./assets/evil.js";'
        ),
      'must export one default Worker object',
    ],
  ])('rejects %s with last-write semantics', (_label, mutate, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      mutate(fs.readFileSync(entryPath, 'utf8'))
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it.each([
    [
      'Sentry SDK',
      'var Sentry=await import',
      'var Sentry=import',
      'must await the trusted Sentry SDK import',
    ],
    [
      'Sentry request owners',
      'var {initializeCloudflareSentryApplication,runWithCloudflareSentry}=await import',
      'var {initializeCloudflareSentryApplication,runWithCloudflareSentry}=import',
      'must await trusted owner initializeCloudflareSentryApplication import',
    ],
    [
      'database owner',
      'var {runWithCloudflareDatabase}=await import',
      'var {runWithCloudflareDatabase}=import',
      'must await trusted owner runWithCloudflareDatabase import',
    ],
    [
      'request telemetry owner',
      'var {configureCloudflareRequestTelemetry}=await import',
      'var {configureCloudflareRequestTelemetry}=import',
      'must await trusted owner configureCloudflareRequestTelemetry import',
    ],
    [
      'request lifecycle owner',
      'var {scheduleCloudflareRequestFlush}=await import',
      'var {scheduleCloudflareRequestFlush}=import',
      'must await trusted owner scheduleCloudflareRequestFlush import',
    ],
    [
      'application factory',
      'const {createApplicationServerEntry}=await import',
      'const {createApplicationServerEntry}=import',
      'must await the application server-entry import',
    ],
  ])('rejects an unawaited %s import', (_label, search, replacement, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs.readFileSync(entryPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it('rejects an unawaited outer Cloudflare request owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'return await fetchCloudflareApplication(',
          'return fetchCloudflareApplication('
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await its Sentry-owned response before flushing');
  });

  it('rejects a missing output directory or wrong compiled profile', () => {
    const missingPublicRoot = fixture();
    createNodeArtifact(missingPublicRoot);
    fs.rmSync(path.join(missingPublicRoot, '.output/node/public'), {
      recursive: true,
    });
    expect(() => verifyRuntimeProfile('node', missingPublicRoot)).toThrow(
      '.output/node/public'
    );

    const wrongProfileRoot = fixture();
    createNodeArtifact(wrongProfileRoot);
    write(
      wrongProfileRoot,
      '.output/node/server/_ssr/ssr.mjs',
      'createApplicationServerEntry("vercel")'
    );
    expect(() => verifyRuntimeProfile('node', wrongProfileRoot)).toThrow(
      'exactly one node profile marker'
    );

    const mixedProfileRoot = fixture();
    createNodeArtifact(mixedProfileRoot);
    write(
      mixedProfileRoot,
      '.output/node/server/_ssr/ssr.mjs',
      'createApplicationServerEntry("node");createApplicationServerEntry("vercel")'
    );
    expect(() => verifyRuntimeProfile('node', mixedProfileRoot)).toThrow(
      'exactly one node profile marker'
    );
  });

  it('rejects incompatible Vercel function metadata', () => {
    const root = fixture();
    createVercelArtifact(root);
    writeJson(root, '.vercel/output/functions/__server.func/.vc-config.json', {
      runtime: 'nodejs22.x',
      supportsResponseStreaming: false,
    });
    expect(() => verifyRuntimeProfile('vercel', root)).toThrow(
      'Vercel Node 24 runtime'
    );
  });

  it('rejects a Cloudflare artifact with a detached database binding token', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/index.js',
      `${cloudflareRuntimeOwners}const worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.MISSING_DATABASE,handle:handleApplication,request});try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{${cloudflareRequestFlush}}}};export{worker_entry_default as default};"cloudflare:workers";"START_UI_DATABASE";START_UI_TELEMETRY_METRICS`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must bind the Cloudflare database owner to environment.START_UI_DATABASE'
    );
  });

  it('rejects a Cloudflare artifact without its source Hyperdrive binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const sourceConfig = JSON.parse(
      fs.readFileSync(path.join(root, 'wrangler.json'), 'utf8')
    );
    delete sourceConfig.hyperdrive;
    writeJson(root, 'wrangler.json', sourceConfig);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare source Hyperdrive bindings');
  });

  it('rejects generated Hyperdrive binding drift', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const generatedConfig = JSON.parse(
      fs.readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8')
    );
    generatedConfig.hyperdrive[0].binding = 'DETACHED_DATABASE';
    writeJson(root, 'dist/server/wrangler.json', generatedConfig);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare generated Hyperdrive binding name');
  });

  it('rejects a Cloudflare database owner hidden in an unreachable helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/index.js',
      `${cloudflareRuntimeOwners}function neverCalled(environment,handle,request){return runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle,request})}const worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}return new Response()}};export{worker_entry_default as default};"cloudflare:workers";START_UI_DATABASE;START_UI_TELEMETRY_METRICS`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must use trusted owner application exactly once');
  });

  it('rejects an unreachable Hyperdrive client assignment', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'try{database=await createHyperdriveDbClient(binding)}',
          'try{if(false){database=await createHyperdriveDbClient(binding)}}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must perform one direct client assignment');
  });

  it('rejects a database declaration that substitutes an active input', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'let database;try{',
          'let database,pwn=(handle=async()=>({body:null}));try{'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must declare one request-local database client');
  });

  it('rejects a decoy database response lifetime binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'return bindCloudflareDatabaseToResponse({database,request,response})',
          'if(false)bindCloudflareDatabaseToResponse({database,request,response});return response'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must validate, handle, and bind one response');
  });

  it('rejects an unawaited Hyperdrive client', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'database=await createHyperdriveDbClient(binding)',
          'database=createHyperdriveDbClient(binding)'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await its Hyperdrive client');
  });

  it('rejects an unawaited database application response', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('const response=await handle()', 'const response=handle()')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await the active application handler');
  });

  it('rejects a database connection failure converted to a response', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'captureDatabaseConnectionFailure(failure);throw failure',
          'return new Response("bypassed")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve connection failures');
  });

  it('rejects a scoped database failure converted to a response', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'await closeDatabase(database);throw failure',
          'return new Response("bypassed")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve scoped request failures');
  });

  it('rejects substituted database helper imports', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'import{createHyperdriveDbClient,runWithRuntimeDatabaseClient}from"./client-fixture.js";',
          'import{createHyperdriveDbClient as realCreateHyperdriveDbClient,runWithRuntimeDatabaseClient}from"./client-fixture.js";const createHyperdriveDbClient=()=>({});'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted helper createHyperdriveDbClient exactly once'
    );
  });

  it('rejects a no-op database close owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const closeDatabase=.*?;const captureDatabaseConnectionFailure=/u,
          'const closeDatabase=async()=>{};const captureDatabaseConnectionFailure='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('database close owner must accept one active client');
  });

  it('rejects an identity database response binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const bindCloudflareDatabaseToResponse=.*?;const runWithCloudflareDatabase=/u,
          'const bindCloudflareDatabaseToResponse=({database,request,response})=>response;const runWithCloudflareDatabase='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('database response owner must own its stream lifecycle body');
  });

  it.each(['closeDatabase', 'bindCloudflareDatabaseToResponse'])(
    'rejects a later %s redeclaration',
    (owner) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(
        root,
        'dist/server/assets/database-request-fixture.js'
      );
      write(
        root,
        'dist/server/assets/database-request-fixture.js',
        fs
          .readFileSync(chunkPath, 'utf8')
          .replace(`const ${owner}=`, `var ${owner}=`)
          .replace(
            ';const runWithCloudflareDatabase=',
            `;var ${owner}=()=>{};const runWithCloudflareDatabase=`
          )
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(`must define trusted helper ${owner} exactly once`);
    }
  );

  it('rejects a shadowed response-stream built-in', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          ';const runWithCloudflareDatabase=',
          ';const TransformStream=class{constructor(){throw new Error("bypassed")}};const runWithCloudflareDatabase='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the trusted TransformStream built-in');
  });

  it.each([
    ['a default import', 'import Response from"./evil.js";', 'Response'],
    [
      'a namespace import',
      'import*as TransformStream from"./evil.js";',
      'TransformStream',
    ],
  ])('rejects %s built-in shadowing', (_label, declaration, builtIn) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      `${declaration}${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must use the trusted ${builtIn} built-in`);
  });

  it.each(['globalThis', 'self'])(
    'rejects %s built-in mutation in the database owner chunk',
    (globalAlias) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(
        root,
        'dist/server/assets/database-request-fixture.js'
      );
      write(
        root,
        'dist/server/assets/database-request-fixture.js',
        `${globalAlias}.Response=class{};${fs.readFileSync(chunkPath, 'utf8')}`
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must not access alternate global built-ins');
    }
  );

  it('rejects call-based poisoning of a database stream built-in', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/database-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/database-request-fixture.js',
      `Object.assign(Response.prototype,{body:null});${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the trusted Response built-in');
  });

  it.each([
    [
      'then',
      '.then(()=>closeDatabase(database))',
      '[then](()=>closeDatabase(database))',
      'must close after stream completion',
    ],
    [
      'catch',
      '.catch(()=>void 0)',
      '["catch"](()=>void 0)',
      'must isolate producer termination',
    ],
    [
      'pipeTo',
      '.pipeTo(writable,{signal:request.signal})',
      '[pipeTo](writable,{signal:request.signal})',
      'must pipe the active body',
    ],
  ])(
    'rejects a computed database pipeline %s member',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(
        root,
        'dist/server/assets/database-request-fixture.js'
      );
      write(
        root,
        'dist/server/assets/database-request-fixture.js',
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it('rejects a Cloudflare database owner after an unwrapped response path', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/index.js',
      `${cloudflareRuntimeOwners}const worker_entry_default={async fetch(request,environment,context){${cloudflareNativeTelemetrySetup}${cloudflareSentryOptionsDeclaration}const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});if(true)return new Response();try{return await fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})}finally{${cloudflareRequestFlush}}}};export{worker_entry_default as default};"cloudflare:workers";START_UI_TELEMETRY_METRICS`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must have exactly one Sentry-owned return path');
  });

  it('rejects request-body consumption before the owned request path', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try{',
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});void request.arrayBuffer();try{'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only its bounded runtime ownership sequence');
  });

  it.each([
    [
      'native telemetry declaration',
      'let nativeTelemetry=lastKnownNativeTelemetry;',
      'let nativeTelemetry=lastKnownNativeTelemetry,pwn=request.arrayBuffer();',
    ],
    [
      'application handler declaration',
      'const handleApplication=()=>application.fetch(request,{context:void 0});',
      'const handleApplication=()=>application.fetch(request,{context:void 0}),pwn=request.arrayBuffer();',
    ],
  ])('rejects side-effect work in the %s', (_label, search, replacement) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs.readFileSync(entryPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only its bounded runtime ownership sequence');
  });

  it('rejects a Cloudflare artifact with a bypassed Sentry owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOwner,
          'const fetchCloudflareApplication=({handle})=>handle();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare Sentry owner must accept the active request inputs');
  });

  it('rejects a Cloudflare artifact with a bypassed application handler', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request,{context:void 0})',
          'const handleApplication=()=>new Response("bypassed")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must use trusted owner application exactly once');
  });

  it('rejects duplicate runtime-effective Cloudflare owner properties', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'binding:environment.START_UI_DATABASE,handle:handleApplication,request',
          'binding:environment.START_UI_DATABASE,handle:handleApplication,request,binding:environment.MISSING_DATABASE'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Cloudflare database owner must not contain duplicate properties'
    );
  });

  it('rejects computed runtime-effective Cloudflare owner properties', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const source = fs
      .readFileSync(entryPath, 'utf8')
      .replace(
        `${cloudflareSentryOwner}var worker_entry_default`,
        `${cloudflareSentryOwner}const bindingKey="binding";var worker_entry_default`
      )
      .replace(
        'binding:environment.START_UI_DATABASE,handle:handleApplication,request',
        'binding:environment.START_UI_DATABASE,handle:handleApplication,request,[bindingKey]:environment.MISSING_DATABASE'
      );
    write(root, 'dist/server/index.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare database owner must use static property keys');
  });

  it('rejects legal var redeclaration of a Cloudflare owner callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=',
          'var handleApplication=()=>application.fetch(request,{context:void 0});var handleApplication=()=>new Response("bypassed");const handleDatabase='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must declare its application handler exactly once');
  });

  it('rejects destructuring var redeclaration of a Cloudflare owner callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=',
          'var handleApplication=()=>application.fetch(request,{context:void 0});var {replacement:handleApplication}={replacement:()=>new Response("bypassed")};const handleDatabase='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must declare its application handler exactly once');
  });

  it('rejects a default parameter that substitutes the application request', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request,{context:void 0});',
          'const handleApplication=(request=new Request("https://bypassed.test"))=>application.fetch(request,{context:void 0});'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('active application handler must accept no substitutable inputs');
  });

  it('rejects a default parameter that substitutes the database callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase',
          'const handleDatabase=(handleApplication=()=>new Response("bypassed"))=>runWithCloudflareDatabase'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('active database handler must accept no substitutable inputs');
  });

  it.each([
    ['request', 'var request=new Request("https://bypassed.test");'],
    [
      'environment',
      'var environment={START_UI_DATABASE:{connectionString:"postgresql://bypassed.test/app"}};',
    ],
  ])(
    'rejects var redeclaration of the active fetch %s parameter',
    (parameter, redeclaration) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const entryPath = path.join(root, 'dist/server/index.js');
      write(
        root,
        'dist/server/index.js',
        fs
          .readFileSync(entryPath, 'utf8')
          .replace(
            cloudflareSentryOptionsDeclaration,
            `${redeclaration}${cloudflareSentryOptionsDeclaration}`
          )
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(`Worker fetch must not override active parameter ${parameter}`);
    }
  );

  it('rejects an extra parameter that shadows the Sentry wrapper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '({context,handle,request,sentryOptions})=>',
          '({context,handle,request,sentryOptions},runWithCloudflareSentry=({handle})=>handle())=>'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare Sentry owner must accept exactly one request input');
  });

  it('rejects a catch parameter captured by a hoisted application callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request,{context:void 0});',
          'try{throw new Request("https://bypassed.test")}catch(request){var handleApplication=()=>application.fetch(request,{context:void 0})}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not override active parameter request');
  });

  it('rejects a destructured catch parameter captured by an application callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request,{context:void 0});',
          'try{throw {request:new Request("https://bypassed.test")}}catch({request}){var handleApplication=()=>application.fetch(request,{context:void 0})}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not override active parameter request');
  });

  it('rejects an active callback captured from a catch binding', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});',
          'try{throw ()=>new Response("bypassed")}catch(handleApplication){var handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request})}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not shadow active binding handleApplication');
  });

  it('rejects unrelated top-level functions even with local catch bindings', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'var worker_entry_default=',
          'const unrelated=()=>{try{throw 1}catch(request){return request}};var worker_entry_default='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must contain only its bounded Cloudflare module ownership sequence'
    );
  });

  it('rejects redeclared validated Sentry options', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          'var {sentryOptions}=configureCloudflareRequestTelemetry({environment,nativeTelemetry,request,sentry:Sentry,sentryRequestIsolationReady});var {sentryOptions}={sentryOptions:void 0};'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Worker fetch must declare validated Sentry options exactly once'
    );
  });

  it('rejects Sentry options not initialized by request telemetry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          'const {sentryOptions}=bypassTelemetry();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Worker fetch must initialize validated Sentry options from request telemetry'
    );
  });

  it('rejects an unreachable validated Sentry options declaration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          `if(false){var ${cloudflareSentryOptionsDeclaration.slice('const '.length)}}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must declare validated Sentry options directly');
  });

  it('rejects mutable validated Sentry options', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          cloudflareSentryOptionsDeclaration.replace('const ', 'let ')
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must keep validated Sentry options immutable');
  });

  it('rejects missing request telemetry configuration inputs', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          'const {sentryOptions}=configureCloudflareRequestTelemetry();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must pass one validated request telemetry input');
  });

  it('rejects disabled request isolation passed to telemetry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'sentryRequestIsolationReady});',
          'sentryRequestIsolationReady:false});'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Cloudflare request telemetry configurator must receive validated request isolation readiness'
    );
  });

  it('rejects a fetch-local request telemetry configurator', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          `const configureCloudflareRequestTelemetry=()=>({sentryOptions:void 0});${cloudflareSentryOptionsDeclaration}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Worker fetch must not override trusted owner configureCloudflareRequestTelemetry'
    );
  });

  it('rejects a request telemetry configurator from an untrusted chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace('request-telemetry-fixture.js', 'telemetry-bypass.js')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must initialize trusted owner configureCloudflareRequestTelemetry from its runtime owner'
    );
  });

  it('rejects a missing request telemetry owner chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace('request-telemetry-fixture.js', 'request-telemetry-missing.js')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('request-telemetry-missing.js');
  });

  it('rejects an aliased request telemetry configurator import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '{configureCloudflareRequestTelemetry}=await import',
          '{bypass:configureCloudflareRequestTelemetry}=await import'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted owner configureCloudflareRequestTelemetry by exact shorthand'
    );
  });

  it('rejects a request telemetry configurator re-export', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'export{configureCloudflareRequestTelemetry}from"./bypass.js";'
    );
    write(
      root,
      'dist/server/assets/bypass.js',
      'const configureCloudflareRequestTelemetry=()=>({sentryOptions:void 0});export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must export trusted owner configureCloudflareRequestTelemetry from one local binding'
    );
  });

  it('rejects a reassigned request telemetry configurator export', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'let configureCloudflareRequestTelemetry=()=>({sentryOptions:{}});configureCloudflareRequestTelemetry=()=>({sentryOptions:void 0});export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must not mutate trusted owner configureCloudflareRequestTelemetry'
    );
  });

  it('rejects a block-level request telemetry configurator reinitialization', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'var configureCloudflareRequestTelemetry=()=>({sentryOptions:{}});{var configureCloudflareRequestTelemetry=()=>({sentryOptions:void 0})}export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must define trusted owner configureCloudflareRequestTelemetry as one local function'
    );
  });

  it('rejects an unreachable request telemetry configurator declaration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'if(false){var configureCloudflareRequestTelemetry=()=>({})}export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must define trusted owner configureCloudflareRequestTelemetry as one local function'
    );
  });

  it('rejects a request telemetry owner without Sentry configuration behavior', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'const configureCloudflareRequestTelemetry=()=>({});export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'trusted owner configureCloudflareRequestTelemetry must call createCloudflareSentryOptions'
    );
  });

  it('rejects unreachable request telemetry configuration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      'import{reportTelemetryFailure,setTelemetry}from"./telemetry-fixture.js";const createCloudflareSentryOptions=()=>({});const createSentryTelemetryAdapter=()=>({});const createTelemetryAdapterChain=()=>({});const configureCloudflareRequestTelemetry=({environment,nativeTelemetry,request,sentry,sentryRequestIsolationReady})=>{setTelemetry(nativeTelemetry);if(!environment.SENTRY_DSN||!sentryRequestIsolationReady)return{};try{if(false){const sentryOptions=createCloudflareSentryOptions(sentry,request,environment);const sentryTelemetry=createSentryTelemetryAdapter(sentry,{flushOwner:"request-wrapper"});setTelemetry(createTelemetryAdapterChain([nativeTelemetry,sentryTelemetry]))}return{sentryOptions:void 0};return{};return{}}catch(failure){reportTelemetryFailure("sentry.cloudflare.configure",failure);return{}}};export{configureCloudflareRequestTelemetry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must create one Sentry options value');
  });

  it('rejects substituted request telemetry helper imports', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-telemetry-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-telemetry-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'import{reportTelemetryFailure,setTelemetry}from"./telemetry-fixture.js";',
          'import{reportTelemetryFailure,setTelemetry as realSetTelemetry}from"./telemetry-fixture.js";const setTelemetry=()=>{};'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import trusted helper setTelemetry exactly once');
  });

  it('rejects an aliased Cloudflare Sentry request owner import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '{initializeCloudflareSentryApplication,runWithCloudflareSentry}=await import',
          '{initializeCloudflareSentryApplication,bypass:runWithCloudflareSentry}=await import'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted owner initializeCloudflareSentryApplication by exact shorthand'
    );
  });

  it('rejects an aliased Cloudflare database owner import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '{runWithCloudflareDatabase}=await import',
          '{bypass:runWithCloudflareDatabase}=await import'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted owner runWithCloudflareDatabase by exact shorthand'
    );
  });

  it('rejects a Sentry SDK chunk missing request-wrapper exports', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/esm-fixture.js',
      'const setAsyncLocalStorageAsyncContextStrategy=()=>{};const withScope=(handle)=>handle();export{setAsyncLocalStorageAsyncContextStrategy,withScope};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must export required Sentry SDK owner wrapRequestHandler');
  });

  it('rejects a Sentry SDK chunk without package provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const sentryEntry = Object.values(manifest).find(
      (entry) => entry.file === 'assets/esm-fixture.js'
    );
    sentryEntry.src = 'src/vendor/sentry.js';
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must originate from @sentry/cloudflare');
  });

  it.each([
    [
      'telemetry entry',
      'assets/telemetry-entry-fixture.js',
      'src/platform/telemetry/index.ts',
    ],
    [
      'native telemetry adapter',
      'assets/telemetry-adapter-fixture.js',
      'src/runtime/cloudflare/telemetry-adapter.ts',
    ],
    [
      'database request owner',
      'assets/database-request-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
    ],
    [
      'request lifecycle owner',
      'assets/request-lifecycle-fixture.js',
      'src/runtime/cloudflare/request-lifecycle.ts',
    ],
    [
      'request telemetry owner',
      'assets/request-telemetry-fixture.js',
      'src/runtime/cloudflare/request-telemetry.ts',
    ],
    [
      'Sentry request owner',
      'assets/sentry-request-fixture.js',
      'src/runtime/cloudflare/sentry-request.ts',
    ],
  ])('rejects forged %s provenance', (_label, file, expectedSource) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const ownerEntry = Object.values(manifest).find(
      (entry) => entry.file === file
    );
    ownerEntry.src = 'src/runtime/cloudflare/forged.ts';
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must originate from ${expectedSource}`);
  });

  it.each([
    ['telemetry entry', 'assets/telemetry-entry-fixture.js'],
    ['native telemetry adapter', 'assets/telemetry-adapter-fixture.js'],
  ])('rejects a missing %s chunk', (_label, file) => {
    const root = fixture();
    createCloudflareArtifact(root);
    fs.rmSync(path.join(root, 'dist/server', file));

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(file);
  });

  it('rejects a telemetry entry that exports a substituted helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/telemetry-entry-fixture.js',
      'import{createNoOpTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";const bypass=()=>({captureException:()=>{}});export{bypass as createNoOpTelemetry,reportTelemetryFailure};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must re-export trusted helper createNoOpTelemetry directly');
  });

  it('rejects a native telemetry adapter exported from a bypass owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/telemetry-adapter-fixture.js',
      'const createCloudflareTelemetryAdapter=()=>({});const bypass=()=>({});export{bypass as createCloudflareTelemetryAdapter};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must export trusted owner createCloudflareTelemetryAdapter from one local binding'
    );
  });

  it('rejects duplicate same-name Sentry SDK owners', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/esm-fixture.js',
      'var setAsyncLocalStorageAsyncContextStrategy=()=>{};var withScope=(handle)=>handle();var withScope=()=>new Response("bypassed");var wrapRequestHandler=(_options,handle)=>handle();export{setAsyncLocalStorageAsyncContextStrategy,withScope,wrapRequestHandler};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must define required Sentry SDK owner withScope exactly once');
  });

  it('rejects Sentry SDK exports aliased to a bypass function', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/esm-fixture.js',
      'const setAsyncLocalStorageAsyncContextStrategy=()=>{};const bypass=()=>{};export{setAsyncLocalStorageAsyncContextStrategy,bypass as withScope,bypass as wrapRequestHandler};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must export required Sentry SDK owner withScope');
  });

  it('rejects a Cloudflare application initialized without the Sentry SDK', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'initializeCloudflareSentryApplication(Sentry,async()',
          'initializeCloudflareSentryApplication(undefined,async()'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must initialize request isolation with the active Sentry API');
  });

  it('rejects a Cloudflare application loader that discards its application', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'return createApplicationServerEntry("cloudflare")',
          'createApplicationServerEntry("cloudflare")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must return its isolated Cloudflare application');
  });

  it('rejects an application factory imported after its use', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const importFactory =
      'const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");';
    const returnApplication =
      'return createApplicationServerEntry("cloudflare")';
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          importFactory + returnApplication,
          returnApplication + ';' + importFactory
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import its application owner after Cloudflare kernel guards'
    );
  });

  it('rejects unawaited outer application isolation initialization', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '=await initializeCloudflareSentryApplication(',
          '=initializeCloudflareSentryApplication('
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await application request isolation initialization');
  });

  it('rejects local substitution of the application server-entry factory', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const source = fs
      .readFileSync(entryPath, 'utf8')
      .replace(
        '{createApplicationServerEntry}=await import',
        '{other:createApplicationServerEntry}=await import'
      );
    write(root, 'dist/server/index.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import createApplicationServerEntry by exact shorthand');
  });

  it('rejects a forged universal application server-entry chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/create-application-server-entry-fixture.js',
      'const createApplicationServerEntry=()=>({fetch:()=>new Response("bypassed")});export{createApplicationServerEntry};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('universal application server entry must be async');
  });

  it('rejects an unawaited Cloudflare application load', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'application:await loadApplication()',
          'application:loadApplication()'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await its active application loader');
  });

  it('rejects an unreachable Sentry application execution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'response:await handle()',
          'response:(false?await handle():new Response("bypassed"))'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must await the active application handler');
  });

  it('rejects a Sentry runner that converts application failure to success', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'return{failure,type:"failed"}',
          'return{response:new Response("bypassed"),type:"responded"}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must return the active application failure');
  });

  it('rejects an injected early return after the Sentry request scope', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'if(applicationOutcome?.type==="responded")',
          'if(request.headers.get("x-bypass"))return new Response("bypassed");if(applicationOutcome?.type==="responded")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must have one bounded post-SDK path');
  });

  it('rejects an injected early return inside the Sentry request scope', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          ';if(sentryResponse.body)',
          ';if(request.headers.get("x-bypass"))return new Response("bypassed");if(sentryResponse.body)'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must execute one bounded SDK request scope');
  });

  it('rejects a conditional Sentry request-scope initializer', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const sentryResponse=await api.withScope(',
          'const sentryResponse=request.headers.get("x-bypass")?new Response("bypassed"):await api.withScope('
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must enter SDK isolation directly');
  });

  it('rejects extra Sentry request-wrapper options', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          '{...requestOptions,request:sentryLifecycleRequest(request)}',
          '{...requestOptions,captureErrors:true,request:sentryLifecycleRequest(request)}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must pass exact active request options');
  });

  it('rejects a side-effecting Sentry request-handler parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'async()=>{applicationOutcome=await runApplicationOnce()',
          'async(leak=exfiltrate(request))=>{applicationOutcome=await runApplicationOnce()'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own its bounded application body');
  });

  it('rejects a second application outcome inside the Sentry wrapper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          ';if(applicationOutcome.type==="failed")',
          ';applicationOutcome={response:new Response("bypassed"),type:"responded"};if(applicationOutcome.type==="failed")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own its bounded application body');
  });

  it('rejects a finalizer that overrides the Sentry application outcome', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'catch(failure){return{failure,type:"failed"}}});',
          'catch(failure){return{failure,type:"failed"}}finally{return undefined}});'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must return one application outcome');
  });

  it('rejects duplicate Sentry isolation owners', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const initializeCloudflareSentryIsolation=',
          'var initializeCloudflareSentryIsolation='
        )
        .replace(
          'export{initializeCloudflareSentryApplication',
          'var initializeCloudflareSentryIsolation=()=>false;export{initializeCloudflareSentryApplication'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must define trusted helper initializeCloudflareSentryIsolation exactly once'
    );
  });

  it('rejects a fake Promise owner that skips Sentry application execution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'Promise.resolve().then(async()',
          '({then:(_callback)=>Promise.resolve({response:new Response("bypassed"),type:"responded"})}).then(async()'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the trusted Promise owner');
  });

  it.each([
    ['a default import', 'import Promise from"./evil.js";', 'Promise'],
    [
      'call-based poisoning',
      'Object.assign(Promise,{resolve:()=>({then:()=>Promise.resolve()})});',
      'Promise',
    ],
  ])('rejects %s of a Sentry built-in', (_label, injection, builtIn) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      `${injection}${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must use the trusted ${builtIn} built-in`);
  });

  it('rejects alternate-global mutation of a Sentry built-in', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      `self.Promise=class{};${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not access alternate global built-ins');
  });

  it('rejects a substituted Sentry lifecycle request helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const sentryLifecycleRequest=.*?;const initializeCloudflareSentryIsolation/u,
          'const sentryLifecycleRequest=(request)=>(Request,request);const initializeCloudflareSentryIsolation'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must bound request normalization');
  });

  it('rejects a substituted Sentry sentinel helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const sentrySentinelResponse=.*?;const sentryLifecycleRequest/u,
          'const sentrySentinelResponse=(applicationCompletion)=>(ReadableStream,new Response());const sentryLifecycleRequest'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must create one bounded streaming response');
  });

  it('rejects a generator Sentry sentinel stream callback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('{start(controller){', '{*start(controller){')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own one stream start callback');
  });

  it.each([
    ['registerRequestCompletion', 'n', '{}'],
    ['snapshotRequestCompletions', 'r', '[]'],
  ])('rejects a substituted %s import', (helper, importedName, fallback) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    const importEntry = `${importedName} as ${helper}`;
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(importEntry, `${importedName} as real${helper}`)
        .replace(
          ';const sentrySentinelResponse=',
          `;const ${helper}=()=>${fallback};const sentrySentinelResponse=`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must import trusted helper ${helper} exactly once`);
  });

  it('rejects a substituted Sentry telemetry reporter import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'import{reportTelemetryFailure}from"./telemetry-fixture.js";',
          'import{reportTelemetryFailure as realReportTelemetryFailure}from"./telemetry-fixture.js";const reportTelemetryFailure=()=>{};'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import trusted helper reportTelemetryFailure exactly once');
  });

  it.each([
    [
      'async Sentry isolation owner',
      'const initializeCloudflareSentryIsolation=(api)=>',
      'const initializeCloudflareSentryIsolation=async(api)=>',
      'must define Sentry async-context isolation',
    ],
    [
      'async lifecycle request owner',
      'const sentryLifecycleRequest=(request)=>',
      'const sentryLifecycleRequest=async(request)=>',
      'must bound request normalization',
    ],
    [
      'generator application owner',
      'const initializeCloudflareSentryApplication=async(api,loadApplication)=>',
      'const initializeCloudflareSentryApplication=async function*(api,loadApplication)',
      'must accept exact initialization inputs',
    ],
    [
      'generator Sentry request owner',
      'const runWithCloudflareSentry=async({api,handle,request,requestOptions})=>',
      'const runWithCloudflareSentry=async function*({api,handle,request,requestOptions})',
      'must accept exact active request inputs',
    ],
  ])('rejects an %s', (_label, search, replacement, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it.each([
    [
      'non-function sentinel start callback',
      '{start(controller){applicationCompletion.then(()=>controller.close(),()=>controller.close())}}',
      '{start:0}',
      'must own one stream start callback',
    ],
    [
      'non-function sentinel settlement callback',
      'applicationCompletion.then(()=>controller.close(),()=>controller.close())',
      'applicationCompletion.then(null,()=>controller.close())',
      'must close its stream on completion',
    ],
    [
      'expression-bodied Sentry request wrapper',
      'async()=>{applicationOutcome=await runApplicationOnce();if(applicationOutcome.type==="failed")throw applicationOutcome.failure;return sentrySentinelResponse(Promise.allSettled(snapshotRequestCompletions(request)))}',
      'async()=>runApplicationOnce()',
      'must own its bounded application body',
    ],
    [
      'non-function SDK drain settlement callback',
      '.then(()=>void 0).catch(',
      '.then(null).catch(',
      'must settle its SDK response drain',
    ],
    [
      'expression-bodied SDK drain failure callback',
      '.catch((failure)=>{reportTelemetryFailure("sentry.cloudflare.request_stream",failure)})',
      '.catch((failure)=>reportTelemetryFailure("sentry.cloudflare.request_stream",failure))',
      'must isolate its SDK response drain',
    ],
  ])('rejects a %s cleanly', (_label, search, replacement, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/sentry-request-fixture.js'
    );
    write(
      root,
      'dist/server/assets/sentry-request-fixture.js',
      fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it('rejects Cloudflare owners initialized out of dependency order', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const databaseImport =
      'var {runWithCloudflareDatabase}=await import("./assets/database-request-fixture.js");';
    const applicationInitialization =
      'var {application,sentryRequestIsolationReady}=await initializeCloudflareSentryApplication(Sentry,async()=>{const kernel=await import("./assets/backend-kernel-fixture.js");kernel.requireRuntimeDatabaseClient();kernel.validateServerBuildConfig("cloudflare");const {createApplicationServerEntry}=await import("./assets/create-application-server-entry-fixture.js");return createApplicationServerEntry("cloudflare")});';
    const source = fs.readFileSync(entryPath, 'utf8');
    write(
      root,
      'dist/server/index.js',
      source
        .replace(databaseImport, '')
        .replace(
          applicationInitialization,
          databaseImport + applicationInitialization
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must initialize Cloudflare runtime owners in dependency order');
  });

  it('rejects Sentry configuration before native telemetry initialization', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareNativeTelemetrySetup + cloudflareSentryOptionsDeclaration,
          cloudflareSentryOptionsDeclaration + cloudflareNativeTelemetrySetup
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must initialize native telemetry before Sentry options');
  });

  it('rejects unreachable native telemetry configuration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareNativeTelemetrySetup,
          `let nativeTelemetry=lastKnownNativeTelemetry;if(false){${cloudflareNativeTelemetrySetup.replace('let nativeTelemetry=lastKnownNativeTelemetry;', '')}}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must directly configure native telemetry');
  });

  it('rejects resetting native telemetry before Sentry configuration', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareNativeTelemetrySetup + cloudflareSentryOptionsDeclaration,
          `${cloudflareNativeTelemetrySetup}nativeTelemetry=createNoOpTelemetry();${cloudflareSentryOptionsDeclaration}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must assign active native telemetry exactly once');
  });

  it('rejects call-based mutation of active native telemetry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          `Object.assign(nativeTelemetry,{forceFlush:()=>Promise.resolve()});${cloudflareSentryOptionsDeclaration}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not alias active native telemetry');
  });

  it('rejects poisoning the retained native telemetry fallback', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          `${cloudflareSentryOwner}var worker_entry_default`,
          `${cloudflareSentryOwner}lastKnownNativeTelemetry=createNoOpTelemetry();var worker_entry_default`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must only retain the verified native telemetry adapter');
  });

  it('rejects a destructured native telemetry fallback owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'var lastKnownNativeTelemetry=createNoOpTelemetry();',
          'var {captureException:lastKnownNativeTelemetry}=createNoOpTelemetry();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must bind its native telemetry fallback directly');
  });

  it('rejects local substitution of the native telemetry adapter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const source = fs
      .readFileSync(entryPath, 'utf8')
      .replace(
        '{createCloudflareTelemetryAdapter}=await import',
        '{createCloudflareTelemetryAdapter:realCreateCloudflareTelemetryAdapter}=await import'
      )
      .replace(
        'var {runWithCloudflareDatabase}=await import',
        'var createCloudflareTelemetryAdapter=()=>createNoOpTelemetry();var {runWithCloudflareDatabase}=await import'
      );
    write(root, 'dist/server/index.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted owner createCloudflareTelemetryAdapter by exact shorthand'
    );
  });

  it('rejects an empty Cloudflare request finalizer', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(`finally{${cloudflareRequestFlush}}`, 'finally{}')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'Worker fetch must use trusted owner scheduleCloudflareRequestFlush exactly once'
    );
  });

  it('rejects a Cloudflare request owner that catches application failures', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '}finally{' + cloudflareRequestFlush,
          '}catch(failure){throw failure}finally{' + cloudflareRequestFlush
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not intercept application failures');
  });

  it('rejects a telemetry flush owned by the wrong execution context', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'context.waitUntil(completion)',
          'environment.waitUntil(completion)'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the active execution context');
  });

  it('rejects a request lifecycle owner without a bounded force flush', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      'const scheduleCloudflareRequestFlush=(_request,_waitUntil)=>{};export{scheduleCloudflareRequestFlush};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'trusted owner scheduleCloudflareRequestFlush must call forceFlushRequestTelemetry'
    );
  });

  it('rejects unreachable request lifecycle work', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      'import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";import{getTelemetry,reportTelemetryFailure}from"./telemetry-fixture.js";const scheduleCloudflareRequestFlush=(request,waitUntil)=>{if(false){forceFlushRequestTelemetry(request,getTelemetry());waitUntil(Promise.resolve())}};export{scheduleCloudflareRequestFlush};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('request flush owner must have one flush and waitUntil scope');
  });

  it('rejects an unbounded request lifecycle completion mapper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('then(()=>void 0)', 'then(()=>new Promise(()=>{}))')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must settle after bounded completion');
  });

  it('rejects a computed request lifecycle completion member', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('.then(()=>void 0)', '[then](()=>void 0)')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must bound its flush completion');
  });

  it('rejects an expression-bodied request lifecycle owner cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const scheduleCloudflareRequestFlush=.*?;export\{scheduleCloudflareRequestFlush/u,
          'const scheduleCloudflareRequestFlush=(request,waitUntil)=>(forceFlushRequestTelemetry(request,getTelemetry()),waitUntil(Promise.resolve()));export{scheduleCloudflareRequestFlush'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must own its bounded lifecycle body');
  });

  it('rejects a request lifecycle flush declaration with sabotage work', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const flush=forceFlushRequestTelemetry(request,getTelemetry()).then(()=>void 0);',
          'const flush=forceFlushRequestTelemetry(request,getTelemetry()).then(()=>void 0),sabotage=(()=>{throw new Error("bypass")})();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must isolate one immutable flush completion');
  });

  it('rejects a request lifecycle failure handler that rethrows', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'reportTelemetryFailure("otel.cloudflare.wait_until",failure)',
          'reportTelemetryFailure("otel.cloudflare.wait_until",failure);throw failure'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not propagate waitUntil failures');
  });

  it('rejects substituted request lifecycle helper imports', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";',
          'import{forceFlushRequestTelemetry as realForceFlushRequestTelemetry}from"./request-completion-fixture.js";const forceFlushRequestTelemetry=()=>Promise.resolve();'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted helper forceFlushRequestTelemetry exactly once'
    );
  });

  it('rejects the wrong export imported as a request lifecycle helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const lifecyclePath = path.join(
      root,
      'dist/server/assets/request-lifecycle-fixture.js'
    );
    write(
      root,
      'dist/server/assets/request-completion-fixture.js',
      'import{reportTelemetryFailure}from"./telemetry-fixture.js";const forceFlushTelemetry=()=>Promise.resolve();const forceFlushRequestTelemetry=()=>Promise.resolve();const registerRequestCompletion=()=>{};const snapshotRequestCompletions=()=>[];export{forceFlushTelemetry,forceFlushRequestTelemetry,registerRequestCompletion as n,snapshotRequestCompletions as r};'
    );
    write(
      root,
      'dist/server/assets/request-lifecycle-fixture.js',
      fs
        .readFileSync(lifecyclePath, 'utf8')
        .replace(
          'import{forceFlushRequestTelemetry}from"./request-completion-fixture.js";',
          'import{forceFlushTelemetry as forceFlushRequestTelemetry}from"./request-completion-fixture.js";'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import the forceFlushRequestTelemetry export from its owner chunk'
    );
  });

  it('rejects fetch-local substitutions for trusted Cloudflare owners', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          `const fetchCloudflareApplication=({handle})=>handle();const application={fetch:()=>new Response("bypassed")};const runWithCloudflareDatabase=({handle})=>handle();${cloudflareSentryOptionsDeclaration}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not override trusted owner application');
  });

  it('rejects reassigned Cloudflare request-owner callbacks', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleApplication=()=>application.fetch(request,{context:void 0});const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try',
          'let handleApplication=()=>application.fetch(request,{context:void 0});let handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});handleApplication=()=>new Response("application bypassed");handleDatabase=()=>new Response("database bypassed");try'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not mutate active binding handleApplication');
  });

  it('rejects destructuring reassignment of Cloudflare request-owner callbacks', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try',
          'let handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});[handleDatabase]=[()=>new Response("database bypassed")];try'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not mutate active binding handleDatabase');
  });

  it('rejects nested callback substitution of Cloudflare request owners', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          'const handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});try',
          'let handleDatabase=()=>runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request});const substitute=()=>{handleDatabase=()=>new Response("database bypassed")};substitute();try'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must not mutate active binding handleDatabase');
  });

  it('rejects call-based mutation of a trusted Cloudflare owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          cloudflareSentryOptionsDeclaration,
          `Object.assign(application,{fetch:()=>new Response("bypassed")});${cloudflareSentryOptionsDeclaration}`
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Worker fetch must use trusted owner application exactly once');
  });

  it('rejects top-level aliases used to mutate a trusted Cloudflare owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    const source = fs
      .readFileSync(entryPath, 'utf8')
      .replace(
        `${cloudflareSentryOwner}var worker_entry_default`,
        `${cloudflareSentryOwner}const appAlias=application;var worker_entry_default`
      )
      .replace(
        cloudflareSentryOptionsDeclaration,
        `Object.assign(appAlias,{fetch:()=>new Response("bypassed")});${cloudflareSentryOptionsDeclaration}`
      );
    write(root, 'dist/server/index.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not alias trusted owner application');
  });

  it.each([
    [
      'node',
      createNodeArtifact,
      '.output/node/server/_ssr/ssr.mjs',
      'runWithNodeSentryRequestIsolation',
    ],
    [
      'vercel',
      createVercelArtifact,
      '.vercel/output/functions/__server.func/_ssr/ssr.mjs',
      'runWithVercelSentryRequestIsolation',
    ],
  ])(
    'rejects a %s artifact with detached Sentry request isolation',
    (profile, createArtifact, entry, owner) => {
      const root = fixture();
      createArtifact(root);
      const entryPath = path.join(root, entry);
      write(
        root,
        entry,
        `${fs
          .readFileSync(entryPath, 'utf8')
          .replace(owner, 'undefined')};const detachedOwner = "${owner}"`
      );
      expect(() => verifyRuntimeProfile(profile, root)).toThrow(
        `${profile} server entry owner ${owner}`
      );
    }
  );

  it('rejects a Node artifact without its async-context owner', () => {
    const root = fixture();
    createNodeArtifact(root);
    const owner = '.output/node/server/_ssr/telemetry-owner.mjs';
    const ownerPath = path.join(root, owner);
    write(
      root,
      owner,
      fs
        .readFileSync(ownerPath, 'utf8')
        .replace('new SentryContextManager()', 'new MissingContextOwner()')
    );
    write(
      root,
      '.output/node/server/vendor/unused-sentry.mjs',
      'export class SentryContextManager {}'
    );

    expect(() => verifyRuntimeProfile('node', root)).toThrow(
      'must link its Node async-context owner'
    );
  });

  it('rejects async-context symbols that are unreachable from the initializer', () => {
    const root = fixture();
    createNodeArtifact(root);
    write(
      root,
      '.output/node/server/_ssr/telemetry-owner.mjs',
      'const initializeSentryNodeRequestContext=()=>{};const unused=()=>new SentryContextManager();const alsoUnused=()=>initializeSentryNodeRequestContext();const initNodeTelemetry=async()=>{};export {initNodeTelemetry as n};'
    );

    expect(() => verifyRuntimeProfile('node', root)).toThrow(
      'must link its Node async-context owner'
    );
  });

  it('rejects async-context symbols inside an uncalled nested helper', () => {
    const root = fixture();
    createNodeArtifact(root);
    write(
      root,
      '.output/node/server/_ssr/telemetry-owner.mjs',
      'const initializeSentryNodeRequestContext=()=>{};const initNodeTelemetry=async()=>{const unused=()=>{initializeSentryNodeRequestContext();new SentryContextManager()}};export {initNodeTelemetry as n};'
    );

    expect(() => verifyRuntimeProfile('node', root)).toThrow(
      'must link its Node async-context owner'
    );
  });

  it('rejects a Node artifact that does not await telemetry initialization', () => {
    const root = fixture();
    createNodeArtifact(root);
    const entry = '.output/node/server/_ssr/ssr.mjs';
    const entryPath = path.join(root, entry);
    write(
      root,
      entry,
      fs
        .readFileSync(entryPath, 'utf8')
        .replace('await initNodeTelemetry()', 'initNodeTelemetry()')
    );

    expect(() => verifyRuntimeProfile('node', root)).toThrow(
      'must await its imported Node telemetry initializer'
    );
  });

  it.each([
    [
      'node',
      createNodeArtifact,
      '.output/node/server/_ssr/ssr.mjs',
      'runWithNodeSentryRequestIsolation',
    ],
    [
      'vercel',
      createVercelArtifact,
      '.vercel/output/functions/__server.func/_ssr/ssr.mjs',
      'runWithVercelSentryRequestIsolation',
    ],
  ])(
    'rejects a %s artifact with isolation attached only to a dead call',
    (profile, createArtifact, entry, owner) => {
      const root = fixture();
      createArtifact(root);
      write(
        root,
        entry,
        `createApplicationServerEntry("${profile}");if(false){createApplicationServerEntry("${profile}",undefined,${owner})}`
      );

      expect(() => verifyRuntimeProfile(profile, root)).toThrow(
        `exactly one ${profile} profile marker`
      );
    }
  );

  it('rejects Worker identity drift and recursively leaked dev vars', () => {
    const identityRoot = fixture();
    createCloudflareArtifact(identityRoot);
    expect(() =>
      verifyRuntimeProfile('cloudflare', identityRoot, {
        expectedAppSlug: 'different-app',
      })
    ).toThrow('Cloudflare APP_SLUG identity');

    const devVarsRoot = fixture();
    createCloudflareArtifact(devVarsRoot);
    write(devVarsRoot, 'dist/server/nested/.dev.vars.preview', 'SECRET=x\n');
    expect(() =>
      verifyRuntimeProfile('cloudflare', devVarsRoot, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not contain .dev.vars');
  });

  it.each([[], 'nodejs_compatibility'])(
    'rejects malformed source AsyncLocalStorage compatibility flags: %j',
    (compatibilityFlags) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const sourceConfig = JSON.parse(
        fs.readFileSync(path.join(root, 'wrangler.json'), 'utf8')
      );
      writeJson(root, 'wrangler.json', {
        ...sourceConfig,
        compatibility_flags: compatibilityFlags,
      });
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('Cloudflare Sentry AsyncLocalStorage compatibility');
    }
  );

  it.each([[], 'nodejs_compatibility'])(
    'rejects malformed generated AsyncLocalStorage compatibility flags: %j',
    (compatibilityFlags) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const generatedConfig = JSON.parse(
        fs.readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8')
      );
      writeJson(root, 'dist/server/wrangler.json', {
        ...generatedConfig,
        compatibility_flags: compatibilityFlags,
      });
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('Cloudflare generated AsyncLocalStorage compatibility');
    }
  );

  it.each([undefined, 20260824, '2026/08/24'])(
    'rejects malformed source compatibility date: %j',
    (compatibilityDate) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const sourceConfig = JSON.parse(
        fs.readFileSync(path.join(root, 'wrangler.json'), 'utf8')
      );
      writeJson(root, 'wrangler.json', {
        ...sourceConfig,
        compatibility_date: compatibilityDate,
      });
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('Cloudflare source compatibility date format');
    }
  );

  it.each([undefined, 20260824, '2026/08/24'])(
    'rejects malformed generated compatibility date: %j',
    (compatibilityDate) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const generatedConfig = JSON.parse(
        fs.readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8')
      );
      writeJson(root, 'dist/server/wrangler.json', {
        ...generatedConfig,
        compatibility_date: compatibilityDate,
      });
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('Cloudflare generated compatibility date format');
    }
  );

  it('rejects generated compatibility date drift', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const generatedConfig = JSON.parse(
      fs.readFileSync(path.join(root, 'dist/server/wrangler.json'), 'utf8')
    );
    writeJson(root, 'dist/server/wrangler.json', {
      ...generatedConfig,
      compatibility_date: '2026-08-23',
    });
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare generated compatibility date drift');
  });

  it('rejects runtime-specific provider leakage recursively', () => {
    const cloudflareRoot = fixture();
    createCloudflareArtifact(cloudflareRoot);
    write(
      cloudflareRoot,
      'dist/server/assets/leaked.js',
      'const provider = new AsyncLocalStorageContextManager();'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', cloudflareRoot, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'forbidden cloudflare runtime token AsyncLocalStorageContextManager'
    );

    const localSqliteRoot = fixture();
    createCloudflareArtifact(localSqliteRoot);
    write(
      localSqliteRoot,
      'dist/server/assets/local-sqlite-sink.js',
      'const localSqliteEnabled = true; CREATE TABLE telemetry_summary;'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', localSqliteRoot, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('forbidden cloudflare runtime token telemetry_summary');

    const nodeRoot = fixture();
    createNodeArtifact(nodeRoot);
    write(
      nodeRoot,
      '.output/node/server/chunks/leaked.mjs',
      'import "@vercel/otel";'
    );
    expect(() => verifyRuntimeProfile('node', nodeRoot)).toThrow(
      'forbidden node runtime token @vercel/otel'
    );

    const vercelTraceRoot = fixture();
    createVercelArtifact(vercelTraceRoot);
    write(
      vercelTraceRoot,
      '.vercel/output/functions/__server.func/chunks/leaked.mjs',
      'initOpenTelemetryServer();'
    );
    expect(() => verifyRuntimeProfile('vercel', vercelTraceRoot)).toThrow(
      'forbidden vercel runtime token initOpenTelemetryServer'
    );

    const vercelSqliteRoot = fixture();
    createVercelArtifact(vercelSqliteRoot);
    write(
      vercelSqliteRoot,
      '.vercel/output/functions/__server.func/chunks/local-sqlite-sink.mjs',
      'CREATE TABLE telemetry_summary;'
    );
    expect(() => verifyRuntimeProfile('vercel', vercelSqliteRoot)).toThrow(
      'forbidden vercel runtime token telemetry_summary'
    );
  });

  it('rejects malformed Vite manifest entries with a bounded diagnostic', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    writeJson(root, 'dist/server/.vite/manifest.json', { malformed: null });

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain valid Vite manifest entries');
  });

  it.each([
    [
      'an unreachable framework fetch',
      'try{return await tanstack.default.fetch(request,{context})}',
      'try{if(false)return await tanstack.default.fetch(request,{context});return new Response("bypassed")}',
      'must execute the live TanStack application request path',
    ],
    [
      'an application owner return before its imports',
      'const tanstack=await import("./entry-server-fixture.js");',
      'return new Response("bypassed");const tanstack=await import("./entry-server-fixture.js");',
      'must import owners before returning one TanStack server entry',
    ],
    [
      'request-body consumption in the request-state prelude',
      'bindRequestExceptionState(request,telemetryCaptureState);',
      'void request.arrayBuffer();',
      'universal request owner must establish exact request state',
    ],
    [
      'a substituted runtime profile in the request context',
      'requestId:crypto.randomUUID(),runtimeProfile,telemetryCaptureState',
      'requestId:crypto.randomUUID(),runtimeProfile:"substituted",telemetryCaptureState',
      'universal request owner must establish exact request state',
    ],
    [
      'a framework-failure catch that returns before rethrowing',
      'if(isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error))telemetryProxy.captureException(error,{level:"error",tags:{event:"framework.request.failed",requestId:context.requestId}});',
      'return {bypassed:true};',
      'universal request owner must preserve framework failures',
    ],
    [
      'a malformed application execution memoizer',
      'applicationResult??=handleRequest();',
      'return handleRequest();',
      'universal request owner must memoize one application execution',
    ],
  ])(
    'rejects %s in the universal application chunk',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath =
        'dist/server/assets/create-application-server-entry-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it('rejects mutation of a trusted helper in its owner chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/request-completion-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          ';export{forceFlushRequestTelemetry,',
          ';forceFlushRequestTelemetry=()=>Promise.resolve();export{forceFlushRequestTelemetry,'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not mutate trusted helper forceFlushRequestTelemetry');
  });

  it.each([
    [
      'a sabotaging response declarator',
      'const response=await handle();',
      'const response=await handle(),sabotage=response.body?.cancel();',
      'database owner must isolate one application response',
    ],
    [
      'a malformed body guard',
      'if(!response.body){closeDatabase(database);return response}',
      ';',
      'database response owner must close bodyless responses',
    ],
    [
      'a malformed response pipeline',
      'response.body.pipeTo(writable,{signal:request.signal}).catch(()=>void 0).then(()=>closeDatabase(database));',
      'pipeline;',
      'database response owner must close after stream completion',
    ],
    [
      'a connection-failure reporter that substitutes the failure',
      'captureDatabaseConnectionFailure(failure);throw failure',
      'captureDatabaseConnectionFailure(failure,failure={substituted:true});throw failure',
      'database owner must report connection failures',
    ],
    [
      'a request-failure cleanup that substitutes the failure',
      'await closeDatabase(database);throw failure',
      'await closeDatabase(database,failure={substituted:true});throw failure',
      'database owner must close the active client after request failure',
    ],
  ])('rejects %s cleanly', (_label, search, replacement, error) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/database-request-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(error);
  });

  it.each([
    [
      'a readiness declaration with application substitution',
      'const sentryRequestIsolationReady=initializeCloudflareSentryIsolation(api);',
      'const sentryRequestIsolationReady=initializeCloudflareSentryIsolation(api),substitute=(loadApplication=async()=>({fetch:()=>new Response("bypassed")}));',
      'Sentry application owner must isolate its readiness state',
    ],
    [
      'an isolation initializer with a side-effecting extra argument',
      'initializeCloudflareSentryIsolation(api);',
      'initializeCloudflareSentryIsolation(api,loadApplication=async()=>({fetch:()=>new Response("bypassed")}));',
      'Sentry application owner must initialize the active SDK isolation',
    ],
    [
      'sentinel metadata without a status',
      ',status:200',
      '',
      'Sentry sentinel owner must emit exact bounded response metadata',
    ],
    [
      'a malformed SDK response drain',
      'sentryResponse.arrayBuffer().then',
      'sentryResponse.then',
      'Sentry request owner must drain one bounded SDK response',
    ],
    [
      'a malformed application memoizer',
      'applicationWork??=Promise.resolve().then(async()=>',
      'return Promise.resolve();Promise.resolve().then(async()=>',
      'Sentry request runner must own one memoized application execution',
    ],
  ])(
    'rejects %s with a bounded diagnostic',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath = 'dist/server/assets/sentry-request-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it.each([
    [
      'application.fetch',
      'dist/server/index.js',
      'application.fetch(request,{context:void 0})',
      'application.fetch(request,{context:void 0},request.arrayBuffer())',
      'active application handler must invoke application.fetch with the active request',
    ],
    [
      'the outer Sentry request owner',
      'dist/server/index.js',
      'fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions})',
      'fetchCloudflareApplication({context,handle:handleDatabase,request,sentryOptions},request.arrayBuffer())',
      'Worker fetch must return or await its Sentry-owned response',
    ],
    [
      'the Sentry request wrapper',
      'dist/server/index.js',
      'runWithCloudflareSentry({api:Sentry,handle,request,requestOptions:{captureErrors:false,context,options:sentryOptions,request}})',
      'runWithCloudflareSentry({api:Sentry,handle,request,requestOptions:{captureErrors:false,context,options:sentryOptions,request}},request.arrayBuffer())',
      'Cloudflare Sentry owner must invoke runWithCloudflareSentry',
    ],
    [
      'the Worker database owner',
      'dist/server/index.js',
      'runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request})',
      'runWithCloudflareDatabase({binding:environment.START_UI_DATABASE,handle:handleApplication,request},request.arrayBuffer())',
      'active database handler must return its database-owned response',
    ],
    [
      'the Hyperdrive client factory',
      'dist/server/assets/database-request-fixture.js',
      'createHyperdriveDbClient(binding)',
      'createHyperdriveDbClient(binding,handle=async()=>new Response("bypassed"))',
      'database owner must create its client from Hyperdrive',
    ],
    [
      'the runtime database scope',
      'dist/server/assets/database-request-fixture.js',
      '}})};export{runWithCloudflareDatabase};',
      '}},request={signal:void 0})};export{runWithCloudflareDatabase};',
      'database owner must return its runtime database scope',
    ],
    [
      'the database response binder',
      'dist/server/assets/database-request-fixture.js',
      'bindCloudflareDatabaseToResponse({database,request,response})',
      'bindCloudflareDatabaseToResponse({database,request,response},response.body?.cancel())',
      'database owner must return its response lifetime binding',
    ],
  ])(
    'rejects a side-effecting extra argument at %s',
    (_label, relativePath, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const chunkPath = path.join(root, relativePath);
      const source = fs.readFileSync(chunkPath, 'utf8');
      const mutated = source.replace(search, replacement);
      write(root, relativePath, mutated);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it.each([
    [
      'validateServerConfig("cloudflare",{databaseAdapter:database.$adapter})',
      'validateServerConfig("cloudflare")',
    ],
    [
      'validateServerConfig("cloudflare",{databaseAdapter:database.$adapter})',
      'validateServerConfig("cloudflare",{})',
    ],
  ])(
    'rejects an incomplete Cloudflare database validation payload',
    (search, replacement) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath = 'dist/server/assets/database-request-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('database owner must validate the Cloudflare adapter in scope');
    }
  );

  it.each([
    [
      'an injected loader import',
      'const kernel=await import("./assets/backend-kernel-fixture.js");',
      'await import("./assets/evil.js");const kernel=await import("./assets/backend-kernel-fixture.js");',
    ],
    [
      'a missing runtime-database guard',
      'kernel.requireRuntimeDatabaseClient();',
      '',
    ],
    [
      'a substituted build-profile guard',
      'kernel.validateServerBuildConfig("cloudflare");',
      'kernel.validateServerBuildConfig("node");',
    ],
  ])('rejects %s in the application loader', (_label, search, replacement) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs.readFileSync(entryPath, 'utf8').replace(search, replacement)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('application loader must run exact Cloudflare kernel guards');
  });

  it('rejects a missing Cloudflare kernel owner chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    fs.rmSync(path.join(root, 'dist/server/assets/backend-kernel-fixture.js'));

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('backend-kernel-fixture.js');
  });

  it.each([
    ['src', 'src/modules/kernel/forged.ts'],
    ['isDynamicEntry', false],
  ])('rejects forged kernel %s provenance', (field, value) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/modules/kernel/backend.ts'][field] = value;
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must originate from src/modules/kernel/backend.ts');
  });

  it('rejects a kernel facade missing a required guard export', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/backend-kernel-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'export{requireRuntimeDatabaseClient,validateServerBuildConfig}',
          'export{validateServerBuildConfig}'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must expose exact Cloudflare kernel guards: requireRuntimeDatabaseClient'
    );
  });

  it('rejects a local decoy application factory in the guarded loader', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      fs
        .readFileSync(entryPath, 'utf8')
        .replace(
          '{createApplicationServerEntry}=await import',
          '{createApplicationServerEntry:realCreateApplicationServerEntry}=await import'
        )
        .replace(
          'return createApplicationServerEntry("cloudflare")',
          'const createApplicationServerEntry=()=>({fetch:()=>new Response("bypassed")});return createApplicationServerEntry("cloudflare")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('application loader must run exact Cloudflare kernel guards');
  });

  it.each([
    [
      'a disabled exception-capture guard',
      'isUnexpectedRequestFailure(error)&&claimRequestException(telemetryCaptureState,error)',
      'false&&false',
      'universal request owner must preserve framework failures',
    ],
    [
      'a malformed lifecycle failure scope',
      'finally{try{lifecycle?.onRequestSettled(request)}catch{}}',
      'finally{try{lifecycle?.onRequestSettled(request)}finally{}}',
      'universal request owner must settle its active lifecycle',
    ],
    [
      'a side-effecting application import declaration',
      'const tanstack=await import("./entry-server-fixture.js");',
      'const tanstack=await import("./entry-server-fixture.js"),sabotage=consume(request);',
      'must isolate trusted tanstack import',
    ],
    [
      'a substituted request-scope diagnostic key',
      'reportTelemetryFailure("sentry.request_scope",failure)',
      'reportTelemetryFailure("wrong",failure)',
      'universal request owner must preserve scoped execution',
    ],
    [
      'a side-effecting request-scope argument',
      'return requestScope(runApplicationOnce)',
      'return requestScope(runApplicationOnce,request.arrayBuffer())',
      'universal request owner must preserve scoped execution',
    ],
    [
      'an awaited disabled-scope application call',
      'if(!requestScope)return handleRequest();',
      'if(!requestScope)return await handleRequest();',
      'universal request owner must execute its application exactly once',
    ],
    [
      'a non-call lifecycle settlement statement',
      'lifecycle?.onRequestSettled(request)',
      '1',
      'universal request owner must settle its active lifecycle',
    ],
    [
      'a missing application result declaration',
      'let applicationResult;',
      ';',
      'universal request owner must execute its application exactly once',
    ],
    [
      'an expression-bodied application memoizer',
      'const runApplicationOnce=()=>{applicationResult??=handleRequest();return applicationResult}',
      'const runApplicationOnce=()=>applicationResult??=handleRequest()',
      'universal request owner must memoize one application execution',
    ],
    [
      'a request scope without a failure handler',
      'try{return requestScope(runApplicationOnce)}catch(failure){reportTelemetryFailure("sentry.request_scope",failure);return applicationResult??runApplicationOnce()}',
      'try{return requestScope(runApplicationOnce)}finally{}',
      'universal request owner must preserve scoped execution',
    ],
    [
      'a non-call TanStack entry return',
      'return tanstack.createServerEntry({',
      'return 1||tanstack.createServerEntry({',
      'must return one TanStack server entry',
    ],
  ])(
    'rejects %s with a bounded universal-entry diagnostic',
    (_label, search, replacement, error) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath =
        'dist/server/assets/create-application-server-entry-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs.readFileSync(chunkPath, 'utf8').replace(search, replacement)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(error);
    }
  );

  it('rejects an expression-bodied universal request handler cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    const source = fs.readFileSync(chunkPath, 'utf8');
    const startMarker = 'const handleRequest=async()=>{';
    const endMarker = '};if(!requestScope)';
    const start = source.indexOf(startMarker);
    const end = source.indexOf(endMarker, start);
    const mutated =
      source.slice(0, start) +
      'const handleRequest=async()=>tanstack.default.fetch(request);if(!requestScope)' +
      source.slice(end + endMarker.length);
    write(root, relativePath, mutated);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'universal application server entry must own one live request handler'
    );
  });

  it('rejects a non-function universal fetch owner cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /return tanstack\.createServerEntry\(\{async fetch\(request\)\{[\s\S]*\}\}\)\};export\{createApplicationServerEntry\};/u,
          'return tanstack.createServerEntry({fetch:1})};export{createApplicationServerEntry};'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'universal application server entry must own one live request handler'
    );
  });

  it('rejects substitution of a universal-entry static helper', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'r as createRequestExceptionCaptureState',
          'r as realCreateRequestExceptionCaptureState'
        )
        .replace(
          ';const createApplicationServerEntry=',
          ';const createRequestExceptionCaptureState=()=>({});const createApplicationServerEntry='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must import trusted helper createRequestExceptionCaptureState exactly once'
    );
  });

  it('rejects a universal helper without a Vite manifest record', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest['_request-failure-fixture.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('Cloudflare app-owned manifest graph');
  });

  it('rejects a universal helper detached from its application manifest edge', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const application =
      manifest['src/runtime/create-application-server-entry.ts'];
    application.imports = application.imports.filter(
      (key) => key !== '_request-failure-fixture.js'
    );
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must import exactly its trusted helper manifest records');
  });

  it.each([
    'dist/server/assets/create-application-server-entry-fixture.js',
    'dist/server/assets/database-request-fixture.js',
    'dist/server/assets/request-failure-fixture.js',
  ])('rejects load-time execution in %s', (relativePath) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `fetch("https://invalid.example");${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only inert top-level declarations');
  });

  it('rejects an unbound top-level application initializer', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `const sabotage=missingIdentifier;${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only inert top-level declarations');
  });

  it.each([
    'const sabotage={valueOf:()=>fetch("https://invalid.example")}+1;',
    'const sabotage=+{valueOf:()=>fetch("https://invalid.example")};',
  ])('rejects coercing top-level application initializers', (initializer) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `${initializer}${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only inert top-level declarations');
  });

  it('rejects a collection initializer that crashes during module evaluation', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `const sabotage=new Set({});${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain only inert top-level declarations');
  });

  it('rejects load-time execution in the TanStack entry chunk', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `fetch("https://invalid.example");${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve the import-safe TanStack server entry shape');
  });

  it.each([
    [
      'const entry={fetch:createStartHandler(observedStreamHandler)};',
      'const entry={fetch:fetch("https://invalid.example")};',
    ],
    [
      'const createServerEntry=(serverEntry)=>serverEntry;',
      'const createServerEntry=(serverEntry)=>(fetch("https://invalid.example"),serverEntry);',
    ],
  ])(
    'rejects executable substitutions in the TanStack entry owners',
    (trustedOwner, substitutedOwner) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const relativePath = 'dist/server/assets/entry-server-fixture.js';
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        fs
          .readFileSync(chunkPath, 'utf8')
          .replace(trustedOwner, substitutedOwner)
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must preserve the import-safe TanStack server entry shape');
    }
  );

  it('rejects a substituted TanStack observed stream handler', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          /const observedStreamHandler=.*?;const entry=/u,
          'const observedStreamHandler=defineHandlerCallback(async()=>fetch("https://invalid.example"));const entry='
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve the import-safe TanStack server entry shape');
  });

  it('rejects a TanStack observed stream handler that discards its response', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'return createSsrStreamResponse(router,response)',
          'return(createSsrStreamResponse(router,response),new Response("bypassed"))'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve the import-safe TanStack server entry shape');
  });

  it('rejects a computed side effect in an otherwise unchanged observed handler', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'registerRequestCompletion(request,stream)',
          'registerRequestCompletion(request,stream,globalThis["fetch"]("https://invalid.example"))'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed observed stream handler');
  });

  it.each([
    'new Response(responseStream)',
    'new Response(responseStream,(globalThis["fetch"]("https://invalid.example"),{headers:responseHeaders,status:router.stores.statusCode.get()}))',
  ])('rejects substituted TanStack response options: %s', (substitution) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/entry-server-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'new Response(responseStream,{headers:responseHeaders,status:router.stores.statusCode.get()})',
          substitution
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve the import-safe TanStack server entry shape');
  });

  it.each(['createStartHandler', 'defineHandlerCallback'])(
    'rejects a synchronized same-family %s owner substitution',
    (ownerName) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const trustedFile = 'server-fixture.js';
      const substitutedFile = 'server-decoy-fixture.js';
      const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
      const substitutedOwner = `${ownerName}Decoy`;
      const trustedExports =
        'export{createSsrStreamResponse,createStartHandler,defineHandlerCallback,isbot,StartServer,transformReadableStreamWithRouter}';
      write(
        root,
        `dist/server/assets/${substitutedFile}`,
        fs
          .readFileSync(trustedPath, 'utf8')
          .replace(`const ${ownerName}=`, `const ${substitutedOwner}=`)
          .replace(
            trustedExports,
            trustedExports.replace(
              ownerName,
              `${substitutedOwner} as ${ownerName}`
            )
          )
      );
      const entryPath = 'dist/server/assets/entry-server-fixture.js';
      write(
        root,
        entryPath,
        fs
          .readFileSync(path.join(root, entryPath), 'utf8')
          .replace(trustedFile, substitutedFile)
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const trustedManifestKey = '_server-fixture.js';
      const substitutedManifestKey = '_server-decoy-fixture.js';
      manifest[substitutedManifestKey] = {
        ...manifest[trustedManifestKey],
        file: `assets/${substitutedFile}`,
      };
      const entryImports = manifest['src/entry-server.ts'].imports;
      entryImports.splice(
        entryImports.indexOf(trustedManifestKey),
        1,
        substitutedManifestKey
      );
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(`must import the ${ownerName} export from its owner chunk`);
    }
  );

  it.each(['createStartHandler', 'defineHandlerCallback'])(
    'rejects a synchronized same-name %s body substitution',
    (ownerName) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const trustedFile = 'server-fixture.js';
      const substitutedFile = 'server-decoy-fixture.js';
      const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
      write(
        root,
        `dist/server/assets/${substitutedFile}`,
        fs
          .readFileSync(trustedPath, 'utf8')
          .replace(
            `const ${ownerName}=(handler)=>handler`,
            `const ${ownerName}=(handler)=>(fetch("https://invalid.example"),handler)`
          )
      );
      const entryPath = 'dist/server/assets/entry-server-fixture.js';
      write(
        root,
        entryPath,
        fs
          .readFileSync(path.join(root, entryPath), 'utf8')
          .replace(trustedFile, substitutedFile)
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const trustedManifestKey = '_server-fixture.js';
      const substitutedManifestKey = '_server-decoy-fixture.js';
      manifest[substitutedManifestKey] = {
        ...manifest[trustedManifestKey],
        file: `assets/${substitutedFile}`,
      };
      const entryImports = manifest['src/entry-server.ts'].imports;
      entryImports.splice(
        entryImports.indexOf(trustedManifestKey),
        1,
        substitutedManifestKey
      );
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(`must use the reviewed ${ownerName} implementation`);
    }
  );

  it('rejects a synchronized transitive TanStack server substitution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const trustedFile = 'server-fixture.js';
    const substitutedFile = 'server-decoy-fixture.js';
    const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
    write(
      root,
      `dist/server/assets/${substitutedFile}`,
      fs
        .readFileSync(trustedPath, 'utf8')
        .replace(
          'const createSsrStreamResponse=(_router,response)=>response',
          'const createSsrStreamResponse=(_router,response)=>(fetch("https://invalid.example"),response)'
        )
    );
    const entryPath = 'dist/server/assets/entry-server-fixture.js';
    write(
      root,
      entryPath,
      fs
        .readFileSync(path.join(root, entryPath), 'utf8')
        .replace(trustedFile, substitutedFile)
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const trustedManifestKey = '_server-fixture.js';
    const substitutedManifestKey = '_server-decoy-fixture.js';
    manifest[substitutedManifestKey] = {
      ...manifest[trustedManifestKey],
      file: `assets/${substitutedFile}`,
    };
    const entryImports = manifest['src/entry-server.ts'].imports;
    entryImports.splice(
      entryImports.indexOf(trustedManifestKey),
      1,
      substitutedManifestKey
    );
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack server static import closure');
  });

  it.each([
    [
      'TanStack server',
      {
        parentFile: 'server-fixture.js',
        parentManifestKey: '_server-fixture.js',
        replacementFile: 'createCsrfMiddleware-BBBBBBBB.js',
        replacementManifestKey: '_createCsrfMiddleware-BBBBBBBB.js',
        transform: (source) =>
          source.replace(
            'const createCsrfMiddleware=()=>{}',
            'const createCsrfMiddleware=()=>true'
          ),
        trustedFile: 'createCsrfMiddleware-AAAAAAAA.js',
        trustedManifestKey: '_createCsrfMiddleware-AAAAAAAA.js',
      },
      'must use the reviewed TanStack server static import closure',
    ],
    [
      'React server renderer',
      {
        parentFile: 'server.edge-fixture.js',
        parentManifestKey: '_server.edge-fixture.js',
        replacementFile: 'react-dom-BBBBBBBB.js',
        replacementManifestKey: '_react-dom-BBBBBBBB.js',
        transform: (source) =>
          source.replace(
            'const renderToReadableStream=()=>new ReadableStream()',
            'const renderToReadableStream=()=>fetch("https://invalid.example")'
          ),
        trustedFile: 'react-dom-AAAAAAAA.js',
        trustedManifestKey: '_react-dom-AAAAAAAA.js',
      },
      'must use the reviewed React server renderer static import closure',
    ],
  ])(
    'rejects a synchronized hashed dependency substitution in the %s closure',
    (_label, substitution, expectedMessage) => {
      const root = fixture();
      createCloudflareArtifact(root);
      replaceManifestBackedHashedDependency(root, substitution);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(expectedMessage);
    }
  );

  it('accepts a content-identical hashed dependency rename', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    replaceManifestBackedHashedDependency(root, {
      parentFile: 'server-fixture.js',
      parentManifestKey: '_server-fixture.js',
      replacementFile: 'createCsrfMiddleware-BBBBBBBB.js',
      replacementManifestKey: '_createCsrfMiddleware-BBBBBBBB.js',
      transform: (source) => source,
      trustedFile: 'createCsrfMiddleware-AAAAAAAA.js',
      trustedManifestKey: '_createCsrfMiddleware-AAAAAAAA.js',
    });

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects a synchronized dynamic dependency substitution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const assets = path.join(root, 'dist/server/assets');
    const trustedFile = 'empty-plugin-adapters-AAAAAAAA.js';
    const replacementFile = 'empty-plugin-adapters-BBBBBBBB.js';
    write(
      root,
      `dist/server/assets/${replacementFile}`,
      fs
        .readFileSync(path.join(assets, trustedFile), 'utf8')
        .replace(
          'const emptyPluginAdapter=true',
          'const emptyPluginAdapter=fetch("https://invalid.example")'
        )
    );
    const serverPath = path.join(assets, 'server-fixture.js');
    write(
      root,
      'dist/server/assets/server-fixture.js',
      fs.readFileSync(serverPath, 'utf8').replace(trustedFile, replacementFile)
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest[fixtureEmptyPluginAdaptersSource] = {
      ...manifest[fixtureEmptyPluginAdaptersSource],
      file: `assets/${replacementFile}`,
    };
    fs.rmSync(path.join(assets, trustedFile));
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed empty plugin adapters owner');
  });

  it('rejects mutation of the dynamically loaded getRouter owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(routerPath, 'utf8')
        .replace(
          'function getRouter(){',
          'function getRouter(){globalThis.fetch("https://invalid.example");'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('rejects mutation of a local helper reachable from getRouter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(routerPath, 'utf8')
        .replace(
          'const getRouterCspNonce=()=>undefined',
          'const getRouterCspNonce=()=>globalThis.fetch("https://invalid.example")'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it.each([
    [
      'a transitive alias',
      'const startInstance={};const alias=startInstance;alias.compromised=()=>1;export{startInstance};',
    ],
    [
      'Object.assign',
      'const startInstance={};Object.assign(startInstance,{compromised:()=>1});export{startInstance};',
    ],
    [
      'Reflect.set',
      'const startInstance={};const alias=startInstance;Reflect.set(alias,"compromised",()=>1);export{startInstance};',
    ],
    [
      'an invoked top-level helper',
      'const startInstance={};const mutate=()=>Object.assign(startInstance,{getOptions:()=>fetch("https://invalid.example")});mutate();export{startInstance};',
    ],
    [
      'an array-destructured alias',
      'const startInstance={};const[alias]=[startInstance];alias.getOptions=()=>fetch("https://invalid.example");export{startInstance};',
    ],
    [
      'an object-destructured alias',
      'const startInstance={};const{owner:alias}={owner:startInstance};alias.getOptions=()=>fetch("https://invalid.example");export{startInstance};',
    ],
    [
      'a function-returned alias',
      'const startInstance={};const getOwner=()=>startInstance;getOwner().getOptions=()=>fetch("https://invalid.example");export{startInstance};',
    ],
  ])('rejects startInstance mutation through %s', (_label, source) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/assets/start-AAAAAAAA.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('ignores a shadowed owner mutation inside an unrelated function', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={};const unrelated=(startInstance)=>{startInstance={}};export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('pins a runtime consumer that mutates startInstance through a parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};const mutate=(target)=>{target.compromised=()=>1};mutate(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      startPath,
      'const startInstance={};const mutate=(target)=>{target.compromised=()=>fetch("https://invalid.example")};mutate(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('pins transitive runtime consumers of a reviewed owner parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};const inner=(target)=>{target.compromised=()=>1};const outer=(target)=>inner(target);outer(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      startPath,
      'const startInstance={};const inner=(target)=>{target.compromised=()=>fetch("https://invalid.example")};const outer=(target)=>inner(target);outer(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    [
      'builtin',
      'const startInstance={};const consume=()=>{String(startInstance);return 1};consume();export{startInstance};',
      'const startInstance={};const consume=()=>{String(startInstance);return 2};consume();export{startInstance};',
    ],
    [
      'member',
      'const startInstance={};const sink={consume:()=>1};const consume=()=>{sink.consume(startInstance);return 1};consume();export{startInstance};',
      'const startInstance={};const sink={consume:()=>1};const consume=()=>{sink.consume(startInstance);return 2};consume();export{startInstance};',
    ],
  ])(
    'pins an invoked containing owner before ignoring its %s consumer',
    (_label, trustedSource, substitutedSource) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(root, startPath, trustedSource);
      const startOwnerClosure = emittedReviewDigest(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      );

      write(root, startPath, substitutedSource);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareTanStackOwnerDigests: {
            ...fixtureTanStackOwnerDigests,
            startOwnerClosure,
          },
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must use the reviewed startInstance artifact owner closure');
    }
  );

  it('pins a top-level local method that consumes a reviewed owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const sink={consume(value){return value}};const startInstance={};sink.consume(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      startPath,
      'const sink={consume(value){value.compromised=true;return value}};const startInstance={};sink.consume(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    [
      'named',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance={};sink.consume(startInstance);export{startInstance};',
      'const sink={consume(value){return value}};export{sink};',
      'const sink={consume(value){value.compromised=true;return value}};export{sink};',
    ],
    [
      'default',
      'import sink from"./sink-AAAAAAAA.js";const startInstance={};sink.consume(startInstance);export{startInstance};',
      'const sink={consume(value){return value}};export{sink as default};',
      'const sink={consume(value){value.compromised=true;return value}};export{sink as default};',
    ],
    [
      'namespace',
      'import*as receivers from"./sink-AAAAAAAA.js";const startInstance={};receivers.sink.consume(startInstance);export{startInstance};',
      'const sink={consume(value){return value}};export{sink};',
      'const sink={consume(value){value.compromised=true;return value}};export{sink};',
    ],
  ])(
    'pins a manifest-backed %s-import receiver that consumes a reviewed owner',
    (_kind, startSource, trustedSink, substitutedSink) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      const sinkPath = 'dist/server/assets/sink-AAAAAAAA.js';
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['src/start.ts'].imports = ['_sink-AAAAAAAA.js'];
      manifest['_sink-AAAAAAAA.js'] = {
        file: 'assets/sink-AAAAAAAA.js',
        imports: [],
        name: 'sink',
      };
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      write(root, startPath, startSource);
      write(root, sinkPath, trustedSink);
      const startOwnerClosure = emittedReviewDigest(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      );

      write(root, sinkPath, substitutedSink);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareTanStackOwnerDigests: {
            ...fixtureTanStackOwnerDigests,
            startOwnerClosure,
          },
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must use the reviewed startInstance artifact owner closure');
    }
  );

  it('pins a local tag that consumes a reviewed owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const sink=(strings,value)=>value;const startInstance={};sink`x${startInstance}`;export{startInstance};'
    );
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      startPath,
      'const sink=(strings,value)=>{value.compromised=true;return value};const startInstance={};sink`x${startInstance}`;export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    [
      'named',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance={};sink`x${startInstance}`;export{startInstance};',
      'const sink=(strings,value)=>value;export{sink};',
      'const sink=(strings,value)=>{value.compromised=true;return value};export{sink};',
    ],
    [
      'default',
      'import sink from"./sink-AAAAAAAA.js";const startInstance={};sink`x${startInstance}`;export{startInstance};',
      'const sink=(strings,value)=>value;export{sink as default};',
      'const sink=(strings,value)=>{value.compromised=true;return value};export{sink as default};',
    ],
    [
      'namespace',
      'import*as receivers from"./sink-AAAAAAAA.js";const startInstance={};receivers.sink`x${startInstance}`;export{startInstance};',
      'const sink=(strings,value)=>value;export{sink};',
      'const sink=(strings,value)=>{value.compromised=true;return value};export{sink};',
    ],
  ])(
    'pins a manifest-backed %s-import tag that consumes a reviewed owner',
    (_kind, startSource, trustedSink, substitutedSink) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      const sinkPath = 'dist/server/assets/sink-AAAAAAAA.js';
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['src/start.ts'].imports = ['_sink-AAAAAAAA.js'];
      manifest['_sink-AAAAAAAA.js'] = {
        file: 'assets/sink-AAAAAAAA.js',
        imports: [],
        name: 'sink',
      };
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      write(root, startPath, startSource);
      write(root, sinkPath, trustedSink);
      const startOwnerClosure = emittedReviewDigest(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      );

      write(root, sinkPath, substitutedSink);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          cloudflareTanStackOwnerDigests: {
            ...fixtureTanStackOwnerDigests,
            startOwnerClosure,
          },
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must use the reviewed startInstance artifact owner closure');
    }
  );

  it.each([
    ['call callback', 'sink(()=>startInstance)'],
    ['constructor callback', 'new sink(()=>startInstance)'],
    ['tag callback', 'sink`x${()=>startInstance}`'],
    ['top-level callback owner', 'const read=()=>startInstance;sink(read)'],
    ['object callback payload', 'sink({read:()=>startInstance})'],
  ])('pins an imported consumer reached through a %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    ['call', 'mystery(()=>startInstance)'],
    ['constructor', 'new Mystery(()=>startInstance)'],
    ['tag', 'mystery`x${()=>startInstance}`'],
  ])(
    'rejects a callback owner escape through an unresolved %s',
    (_label, execution) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        `const startInstance={};${execution};export{startInstance};`
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must not escape to an unresolved runtime consumer');
    }
  );

  it.each([
    ['an assignment alias', 'let alias;alias=startInstance;sink(alias)'],
    ['a conditional alias', 'const alias=true?startInstance:{};sink(alias)'],
    ['an indexed array alias', 'const alias=[startInstance][0];sink(alias)'],
  ])('pins an imported consumer reached through %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it.each([
    ['a block-local payload alias', '{const alias=startInstance;sink(alias)}'],
    ['a block-local target alias', '{const local=sink;local(startInstance)}'],
    [
      'a for-of assignment alias',
      'let alias={};for(alias of [startInstance])sink(alias)',
    ],
  ])('pins an imported consumer reached through %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('keeps unrelated statements out of a block-local consumer digest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};{const sink=(value)=>value;const unrelated=1;sink(startInstance)}export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const startInstance={};{const sink=(value)=>value;const unrelated=2;sink(startInstance)}export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps nested shadow mutations out of an outer lexical binding digest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};{const sink=(value)=>value;{let sink;sink=()=>1}sink(startInstance)}export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const startInstance={};{const sink=(value)=>value;{let sink;sink=()=>2}sink(startInstance)}export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    ['call result', 'const load=()=>startInstance;sink(load())'],
    [
      'constructed result',
      'class Box{constructor(){return startInstance}}sink(new Box())',
    ],
    ['tag result', 'const tag=()=>startInstance;sink(tag``)'],
    [
      'local collection roundtrip',
      'const store=new Map();store.set("x",startInstance);sink(store.get("x"))',
    ],
  ])('pins an imported consumer reached through a %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it.each([
    [
      'function-scoped var',
      'const run=()=>{var alias=startInstance;sink(alias)};run()',
    ],
    [
      'catch binding',
      'const run=()=>{try{throw startInstance}catch(alias){sink(alias)}};run()',
    ],
    [
      'object binding default',
      '{const {value:alias=startInstance}={};sink(alias)}',
    ],
    ['array binding default', '{const [alias=startInstance]=[];sink(alias)}'],
    [
      'assignment binding default',
      '{let alias;({value:alias=startInstance}={});sink(alias)}',
    ],
    ['parameter default', 'const run=(alias=startInstance)=>sink(alias);run()'],
    [
      'destructured parameter default',
      'const run=({value:alias=startInstance}={})=>sink(alias);run()',
    ],
    ['for-of declaration', 'for(const alias of [startInstance])sink(alias)'],
    [
      'destructured for-of declaration',
      'for(const {value:alias} of [{value:startInstance}])sink(alias)',
    ],
  ])('pins an imported consumer reached through a %s', (_label, execution) => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${execution};export{startInstance};`
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'function sink(value){value.compromised=true;return value}export{sink};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('does not attribute for-in keys to values in the iterated object', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const sink=(value)=>value;const startInstance={};for(const alias in {value:startInstance})sink(alias);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps unrelated caller declarations out of an imported consumer digest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'import{sink}from"./sink-AAAAAAAA.js";const unrelated=1;const startInstance={};sink(startInstance);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      'function sink(value){return value}export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'import{sink}from"./sink-AAAAAAAA.js";const unrelated=2;const startInstance={};sink(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps a shadowed caller binding from pulling in an unrelated top-level owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    const startSource = (unrelatedValue) =>
      `import{store,load}from"./sink-AAAAAAAA.js";const alias=${unrelatedValue};function run(){let alias;alias=load();return alias}const startInstance={};store(startInstance);run();export{startInstance};`;
    write(root, startPath, startSource(1));
    addCloudflareSinkModule(
      root,
      'let stored;const store=(value)=>{stored=value};const load=()=>stored;export{load,store};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(root, startPath, startSource(2));

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'interaction order',
      'store(startInstance);load()',
      'load();store(startInstance)',
    ],
    [
      'control-flow guard',
      'if(true)sink(startInstance)',
      'if(false)sink(startInstance)',
    ],
  ])(
    'pins imported-consumer caller %s',
    (_label, trustedExecution, substitutedExecution) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(
        root,
        startPath,
        `import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};${trustedExecution};export{startInstance};`
      );
      addCloudflareSinkModule(
        root,
        'let stored;const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{load,sink,store};'
      );
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(
        root,
        startPath,
        `import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};${substitutedExecution};export{startInstance};`
      );

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it('pins the imported export selected by a consumer binding', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'import{sink as consume}from"./sink-AAAAAAAA.js";const startInstance={};consume(startInstance);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      'const sink=(value)=>value;const evil=(value)=>{value.compromised=true;return value};export{evil,sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'import{evil as consume}from"./sink-AAAAAAAA.js";const startInstance={};consume(startInstance);export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it.each([
    [
      'named callback',
      'const callback=(value)=>value;on(callback)',
      'const callback=(value)=>{value.compromised=true;return value};on(callback)',
    ],
    [
      'object callback',
      'const callbacks={receive:(value)=>value};on(callbacks.receive)',
      'const callbacks={receive:(value)=>{value.compromised=true;return value}};on(callbacks.receive)',
    ],
    [
      'transitive callback holder',
      'const callback=(value)=>value;const callbacks={receive:callback};on(callbacks.receive)',
      'const callback=(value)=>{value.compromised=true;return value};const callbacks={receive:callback};on(callbacks.receive)',
    ],
    [
      'block-local consumer chain',
      '{const read=load;const value=read();sink(value)}',
      '{const read=load;const value=read();value.compromised=true;sink(value)}',
    ],
  ])(
    'pins a stateful imported consumer reached through a %s',
    (_label, trustedRegistration, substitutedRegistration) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      const sinkSource =
        'let callback=(value)=>value;let stored;const on=(next)=>{callback=next};const emit=(value)=>callback(value);const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{emit,load,on,sink,store};';
      write(
        root,
        startPath,
        `import{emit,load,on,sink,store}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);${trustedRegistration};emit(startInstance);export{startInstance};`
      );
      addCloudflareSinkModule(root, sinkSource);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(
        root,
        startPath,
        `import{emit,load,on,sink,store}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);${substitutedRegistration};emit(startInstance);export{startInstance};`
      );

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it.each([
    [
      'call receiver',
      'sink.consume(startInstance)',
      'sink.consume=(value)=>{value.compromised=true;return value};sink.consume(startInstance)',
      'const sink={consume(value){return value}};export{sink};',
    ],
    [
      'constructor receiver',
      'new sink.Consumer(startInstance)',
      'sink.Consumer=class{constructor(value){value.compromised=true;return value}};new sink.Consumer(startInstance)',
      'const sink={Consumer:class{constructor(value){return value}}};export{sink};',
    ],
    [
      'tag receiver',
      'sink.tag`x${startInstance}`',
      'sink.tag=(strings,value)=>{value.compromised=true;return value};sink.tag`x${startInstance}`',
      'const sink={tag:(strings,value)=>value};export{sink};',
    ],
  ])(
    'pins a local mutation of an imported %s',
    (_label, trustedExecution, substitutedExecution, sinkSource) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(
        root,
        startPath,
        `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${trustedExecution};export{startInstance};`
      );
      addCloudflareSinkModule(root, sinkSource);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(
        root,
        startPath,
        `import{sink}from"./sink-AAAAAAAA.js";const startInstance={};${substitutedExecution};export{startInstance};`
      );

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it('rejects reviewed owner storage on the global object', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const sink=(value)=>value;const startInstance={};globalThis.slot=startInstance;sink(globalThis.slot);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not escape to an unresolved runtime consumer');
  });

  it('rejects reviewed owner storage on an imported object', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import{store,sink}from"./sink-AAAAAAAA.js";const startInstance={};store.slot=startInstance;sink(store.slot);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      'const store={};const sink=(value)=>value;export{sink,store};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not escape to an unresolved runtime consumer');
  });

  it.each([
    [
      'shared store implementation',
      'let stored;const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{load,sink,store};',
      'let stored;const store=(value)=>{stored=value};const load=()=>{stored.compromised=true;return stored};const sink=(value)=>value;export{load,sink,store};',
      'import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);const alias=load();sink(alias);export{startInstance};',
      'import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);const alias=load();sink(alias);export{startInstance};',
    ],
    [
      'shared store caller',
      'let stored;const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{load,sink,store};',
      'let stored;const store=(value)=>{stored=value};const load=()=>stored;const sink=(value)=>value;export{load,sink,store};',
      'import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);const alias=load();sink(alias);export{startInstance};',
      'import{store,load,sink}from"./sink-AAAAAAAA.js";const startInstance={};store(startInstance);const alias=load();alias.compromised=true;sink(alias);export{startInstance};',
    ],
    [
      'registered callback',
      'let callback=(value)=>value;const on=(next)=>{callback=next};const emit=(value)=>callback(value);export{emit,on};',
      'let callback=(value)=>value;const on=(next)=>{callback=(value)=>{value.compromised=true;return next(value)}};const emit=(value)=>callback(value);export{emit,on};',
      'import{on,emit}from"./sink-AAAAAAAA.js";on(value=>value);const startInstance={};emit(startInstance);export{startInstance};',
      'import{on,emit}from"./sink-AAAAAAAA.js";on(value=>value);const startInstance={};emit(startInstance);export{startInstance};',
    ],
    [
      'registered caller callback',
      'let callback=(value)=>value;const on=(next)=>{callback=next};const emit=(value)=>callback(value);export{emit,on};',
      'let callback=(value)=>value;const on=(next)=>{callback=next};const emit=(value)=>callback(value);export{emit,on};',
      'import{on,emit}from"./sink-AAAAAAAA.js";on(value=>value);const startInstance={};emit(startInstance);export{startInstance};',
      'import{on,emit}from"./sink-AAAAAAAA.js";on(value=>{value.compromised=true;return value});const startInstance={};emit(startInstance);export{startInstance};',
    ],
  ])(
    'pins stateful cross-export interactions through the %s',
    (_label, trustedSink, substitutedSink, trustedStart, substitutedStart) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(root, startPath, trustedStart);
      addCloudflareSinkModule(root, trustedSink);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(root, startPath, substitutedStart);
      write(root, 'dist/server/assets/sink-AAAAAAAA.js', substitutedSink);

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it.each([
    [
      'named',
      'import{sink as String}from"./sink-AAAAAAAA.js";',
      'function sink(value){return value}export{sink};',
      'function sink(value){value.compromised=true;return value}export{sink};',
    ],
    [
      'default',
      'import String from"./sink-AAAAAAAA.js";',
      'function sink(value){return value}export{sink as default};',
      'function sink(value){value.compromised=true;return value}export{sink as default};',
    ],
  ])(
    'does not trust a %s import that collides with an ambient consumer',
    (_label, importSource, trustedSink, substitutedSink) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        `${importSource}const startInstance={};String(startInstance);export{startInstance};`
      );
      addCloudflareSinkModule(root, trustedSink);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(root, 'dist/server/assets/sink-AAAAAAAA.js', substitutedSink);

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it.each([
    [
      'String',
      'class String{constructor(value){return value}}',
      'class String{constructor(value){value.compromised=true;return value}}',
    ],
    [
      'URL',
      'class URL{constructor(value){return value}}',
      'class URL{constructor(value){value.compromised=true;return value}}',
    ],
  ])(
    'pins a local %s class instead of trusting its ambient name',
    (name, trustedClass, substitutedClass) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        `${trustedClass};const startInstance={};new ${name}(startInstance);export{startInstance};`
      );
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        `${substitutedClass};const startInstance={};new ${name}(startInstance);export{startInstance};`
      );

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it('rejects an ambient consumer after its global implementation is overridden', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'globalThis.String=(value)=>value;const startInstance={};String(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /must not (?:escape to an unresolved runtime consumer|execute fetch, eval, or worker effects while loading)/u
    );
  });

  it('rejects an ambient consumer after a constant-key global override', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const key="String";globalThis[key]=(value)=>value;const startInstance={};String(startInstance);export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /must not (?:escape to an unresolved runtime consumer|execute fetch, eval, or worker effects while loading)/u
    );
  });

  it.each([
    ['global alias', 'const root=globalThis;root.String=(value)=>value'],
    ['self member', 'self.String=(value)=>value'],
    ['window member', 'window.String=(value)=>value'],
    [
      'object assignment pattern',
      '({String:globalThis.String}={String:(value)=>value})',
    ],
    ['array assignment pattern', '[globalThis.String]=[(value)=>value]'],
    [
      'for-of assignment target',
      'for(globalThis.String of [(value)=>value]){}',
    ],
    ['Reflect.set on self', 'Reflect.set(self,"String",(value)=>value)'],
    [
      'Object.defineProperty on self',
      'Object.defineProperty(self,"String",{value:(value)=>value})',
    ],
    [
      'legacy getter installation',
      'self.__defineGetter__("String",()=>value=>value)',
    ],
  ])('rejects an ambient consumer after a %s override', (_label, override) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      `${override};const startInstance={};String(startInstance);export{startInstance};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /must not (?:escape to an unresolved runtime consumer|execute fetch, eval, or worker effects while loading)/u
    );
  });

  it.each([
    [
      'Promise method assignment',
      'Promise.resolve=(value)=>value;const startInstance={};Promise.resolve(startInstance);export{startInstance};',
    ],
    [
      'Intl constructor assignment',
      'Intl.Collator=class{constructor(value){return value}};const startInstance={};new Intl.Collator(startInstance);export{startInstance};',
    ],
    [
      'String tag assignment',
      'String.raw=(strings,value)=>value;const startInstance={};String.raw`x${startInstance}`;export{startInstance};',
    ],
    [
      'ambient descriptor installation',
      'Object.defineProperty(Promise,"resolve",{value:(value)=>value});const startInstance={};Promise.resolve(startInstance);export{startInstance};',
    ],
  ])('rejects a reviewed owner after %s', (_label, source) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/assets/start-AAAAAAAA.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      /must not (?:escape to an unresolved runtime consumer|execute fetch, eval, or worker effects while loading)/u
    );
  });

  it.each([
    [
      'call alias',
      'globalThis.JSON={stringify(value){return String(value)}};const consumer=JSON.stringify;const startInstance={};consumer(startInstance);export{startInstance};',
    ],
    [
      'constructor alias',
      'globalThis.Intl={Collator:class{constructor(value){return value}}};const Consumer=Intl.Collator;const startInstance={};new Consumer(startInstance);export{startInstance};',
    ],
    [
      'tag alias',
      'globalThis.String={raw:(strings,value)=>value};const tag=String.raw;const startInstance={};tag`x${startInstance}`;export{startInstance};',
    ],
  ])('preserves ambient provenance through a %s', (_label, source) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'dist/server/assets/start-AAAAAAAA.js', source);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not escape to an unresolved runtime consumer');
  });

  it('pins helper-based global descriptor installation for ambient consumers', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const descriptors=(value)=>value;Object.defineProperties(globalThis,descriptors({Temporal:{value:{}}}));const startInstance={};Boolean(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const descriptors=(value)=>({...value,Boolean:{value:()=>false}});Object.defineProperties(globalThis,descriptors({Temporal:{value:{}}}));const startInstance={};Boolean(startInstance);export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('allows a symbol-keyed global cache without weakening ambient provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const key=Symbol.for("cache");globalThis[key]={};const startInstance={};Boolean(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('pins the assigned result of an owner-consuming execution', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};let escaped;escaped=Promise.resolve(startInstance);escaped.then(value=>value);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const startInstance={};let escaped;escaped=Promise.resolve(startInstance);escaped.then(value=>{value.compromised=true;return value});export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('pins a block-local consumer with a shadowing top-level name', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const sink=(value)=>value;const startInstance={};{const sink=(value)=>value;sink(startInstance)}export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const sink=(value)=>value;const startInstance={};{const sink=(value)=>{value.compromised=true;return value};sink(startInstance)}export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it.each([
    [
      'method alias',
      'const sink={consume(value){return value}};const consume=sink.consume;const startInstance={};consume(startInstance);export{startInstance};',
      'const sink={consume(value){value.compromised=true;return value}};const consume=sink.consume;const startInstance={};consume(startInstance);export{startInstance};',
    ],
    [
      'Function.call',
      'const sink={consume(value){return value}};const startInstance={};sink.consume.call(null,startInstance);export{startInstance};',
      'const sink={consume(value){value.compromised=true;return value}};const startInstance={};sink.consume.call(null,startInstance);export{startInstance};',
    ],
    [
      'Function.apply',
      'const sink={consume(value){return value}};const startInstance={};sink.consume.apply(null,[startInstance]);export{startInstance};',
      'const sink={consume(value){value.compromised=true;return value}};const startInstance={};sink.consume.apply(null,[startInstance]);export{startInstance};',
    ],
    [
      'computed selector',
      'const key="consume";const sink={consume(value){return value}};const startInstance={};sink[key](startInstance);export{startInstance};',
      'const key="consume";const sink={consume(value){value.compromised=true;return value}};const startInstance={};sink[key](startInstance);export{startInstance};',
    ],
    [
      'Reflect.construct',
      'function Sink(value){return value}const startInstance={};Reflect.construct(Sink,[startInstance]);export{startInstance};',
      'function Sink(value){value.compromised=true;return value}const startInstance={};Reflect.construct(Sink,[startInstance]);export{startInstance};',
    ],
  ])(
    'pins a reviewed owner passed through %s',
    (_label, trusted, substituted) => {
      expect.hasAssertions();
      const root = fixture();
      createCloudflareArtifact(root);
      const startPath = 'dist/server/assets/start-AAAAAAAA.js';
      write(root, startPath, trusted);
      const startOwnerClosure = emittedStartOwnerClosure(root);

      write(root, startPath, substituted);

      expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
    }
  );

  it('preserves identical owner-consuming execution occurrences', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const sink=(value)=>value;const startInstance={};sink(startInstance);sink(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const sink=(value)=>value;const startInstance={};sink(startInstance);export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('pins an inline class that consumes a reviewed owner', () => {
    expect.hasAssertions();
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};new(class{constructor(value){return value}})(startInstance);export{startInstance};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      startPath,
      'const startInstance={};new(class{constructor(value){value.compromised=true;return value}})(startInstance);export{startInstance};'
    );

    expectStartOwnerSubstitutionRejected(root, startOwnerClosure);
  });

  it('does not attribute a called helper parameter shadow to startInstance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    write(
      root,
      startPath,
      'const startInstance={};const unrelated=(startInstance)=>{startInstance.compromised=()=>1};unrelated({});export{startInstance};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      startPath,
      'const startInstance={};const unrelated=(startInstance)=>{startInstance.compromised=()=>2};unrelated({});export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps a parameter-shadowed top-level helper outside getRouter reachability', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerPath = 'dist/server/assets/router-AAAAAAAA.js';
    write(
      root,
      routerPath,
      'const shadowedHelper=()=>1;function getRouter(shadowedHelper=()=>({cspNonce:undefined})){return shadowedHelper()}export{getRouter};'
    );
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      routerPath,
      'const shadowedHelper=()=>2;function getRouter(shadowedHelper=()=>({cspNonce:undefined})){return shadowedHelper()}export{getRouter};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          routerLocalClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps function-body var bindings out of default-parameter scope', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerPath = 'dist/server/assets/router-AAAAAAAA.js';
    write(
      root,
      routerPath,
      'const helper=()=>1;function getRouter(value=helper){var helper=()=>0;return{cspNonce:value()}}export{getRouter};'
    );
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      routerPath,
      'const helper=()=>2;function getRouter(value=helper){var helper=()=>0;return{cspNonce:value()}}export{getRouter};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          routerLocalClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('keeps a nested free helper reference in getRouter reachability', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerPath = 'dist/server/assets/router-AAAAAAAA.js';
    write(
      root,
      routerPath,
      'const nestedHelper=()=>1;function getRouter(){return()=>nestedHelper()}export{getRouter};'
    );
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      routerPath,
      'const nestedHelper=()=>2;function getRouter(){return()=>nestedHelper()}export{getRouter};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          routerLocalClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('rejects a synchronized imported getRouter owner substitution', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>undefined;export{importedNonce};'
    );
    write(
      root,
      relativePath,
      `import{importedNonce}from"./router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-helper-AAAAAAAA.js'] = {
      file: 'assets/router-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
    };
    manifest['src/router.tsx'].imports = ['_router-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>fetch("https://invalid.example");export{importedNonce};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('keeps reachable owner identities stable when an unrelated name collides', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>undefined;export{importedNonce};'
    );
    write(
      root,
      routerRelativePath,
      `import{importedNonce}from"./router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    write(
      root,
      'dist/server/assets/unrelated-helper-AAAAAAAA.js',
      'const unrelated=true;export{unrelated};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-helper-AAAAAAAA.js'] = {
      file: 'assets/router-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
    };
    manifest['_unrelated-helper-AAAAAAAA.js'] = {
      file: 'assets/unrelated-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
    };
    manifest['src/router.tsx'].imports = ['_router-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('pins a default-imported getRouter helper implementation', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>undefined;export{importedNonce as default};'
    );
    write(
      root,
      routerRelativePath,
      `import importedNonce from"./router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-helper-AAAAAAAA.js'] = {
      file: 'assets/router-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
    };
    manifest['src/router.tsx'].imports = ['_router-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-helper-AAAAAAAA.js',
      'const importedNonce=()=>fetch("https://invalid.example");export{importedNonce as default};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('does not hard-code app-owned behavior into framework owner digests', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/app-router-helper-AAAAAAAA.js',
      'const importedNonce=()=>1;export{importedNonce};'
    );
    write(
      root,
      routerRelativePath,
      `import{importedNonce}from"./app-router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/modules/example/router-helper.ts'] = {
      file: 'assets/app-router-helper-AAAAAAAA.js',
      imports: [],
      name: 'router-helper',
      src: 'src/modules/example/router-helper.ts',
    };
    manifest['src/router.tsx'].imports = [
      'src/modules/example/router-helper.ts',
    ];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/app-router-helper-AAAAAAAA.js',
      'const importedNonce=()=>fetch("https://example.test/nonce");export{importedNonce};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('traverses from a reviewed owner through an app-only child into non-app code', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/app-router-helper-AAAAAAAA.js',
      'import"./router-vendor-AAAAAAAA.js";const importedNonce=()=>1;export{importedNonce};'
    );
    write(
      root,
      'dist/server/assets/router-vendor-AAAAAAAA.js',
      'const vendorValue=1;export{vendorValue};'
    );
    write(
      root,
      routerRelativePath,
      `import{importedNonce}from"./app-router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/modules/example/router-helper.ts'] = {
      file: 'assets/app-router-helper-AAAAAAAA.js',
      imports: ['_router-vendor-AAAAAAAA.js'],
      name: 'router-helper',
      src: 'src/modules/example/router-helper.ts',
    };
    manifest['_router-vendor-AAAAAAAA.js'] = {
      file: 'assets/router-vendor-AAAAAAAA.js',
      imports: [],
      name: 'router-vendor',
    };
    manifest['src/router.tsx'].imports = [
      'src/modules/example/router-helper.ts',
    ];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markFixtureAppOwnedChunk(root, 'assets/app-router-helper-AAAAAAAA.js', [
      'src/modules/example/router-helper.ts',
    ]);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-vendor-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rescans an earlier shallow chunk after a later caller invokes its export', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/app-router-helper-AAAAAAAA.js',
      'const importedNonce=()=>1;export{importedNonce};'
    );
    write(
      root,
      'dist/server/assets/late-callee-AAAAAAAA.js',
      'const danger=()=>undefined;export{danger};'
    );
    write(
      root,
      'dist/server/assets/late-caller-AAAAAAAA.js',
      'import{danger}from"./late-callee-AAAAAAAA.js";danger();'
    );
    write(
      root,
      routerRelativePath,
      `import{importedNonce}from"./app-router-helper-AAAAAAAA.js";${fs
        .readFileSync(routerPath, 'utf8')
        .replace('()=>undefined', '()=>importedNonce()')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/modules/example/router-helper.ts'] = {
      file: 'assets/app-router-helper-AAAAAAAA.js',
      imports: ['_late-caller-AAAAAAAA.js', '_late-callee-AAAAAAAA.js'],
      name: 'router-helper',
      src: 'src/modules/example/router-helper.ts',
    };
    manifest['_late-caller-AAAAAAAA.js'] = {
      file: 'assets/late-caller-AAAAAAAA.js',
      imports: ['_late-callee-AAAAAAAA.js'],
      name: 'late-caller',
    };
    manifest['_late-callee-AAAAAAAA.js'] = {
      file: 'assets/late-callee-AAAAAAAA.js',
      imports: [],
      name: 'late-callee',
    };
    manifest['src/router.tsx'].imports = [
      'src/modules/example/router-helper.ts',
    ];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markFixtureAppOwnedChunk(root, 'assets/app-router-helper-AAAAAAAA.js', [
      'src/modules/example/router-helper.ts',
    ]);
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    write(
      root,
      'dist/server/assets/late-callee-AAAAAAAA.js',
      'const danger=()=>fetch("https://invalid.example");export{danger};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('follows a namespace-imported load-effect owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      'dist/server/assets/router-effect-AAAAAAAA.js',
      'const run=()=>undefined;export{run};'
    );
    write(
      root,
      routerRelativePath,
      `import*as effects from"./router-effect-AAAAAAAA.js";effects.run();${fs.readFileSync(
        routerPath,
        'utf8'
      )}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-effect-AAAAAAAA.js'] = {
      file: 'assets/router-effect-AAAAAAAA.js',
      imports: [],
      name: 'router-effect',
    };
    manifest['src/router.tsx'].imports = ['_router-effect-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markFixtureAppOwnedChunk(root, 'assets/router-effect-AAAAAAAA.js', [
      'src/router-effect.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-effect-AAAAAAAA.js',
      'const run=()=>fetch("https://invalid.example");export{run};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rejects a cross-chunk load effect invoked by a dynamic owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      'dist/server/assets/router-effect-AAAAAAAA.js',
      'const run=()=>fetch("https://invalid.example");export{run};'
    );
    write(
      root,
      relativePath,
      `import{run}from"./router-effect-AAAAAAAA.js";run();${fs.readFileSync(
        routerPath,
        'utf8'
      )}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-effect-AAAAAAAA.js'] = {
      file: 'assets/router-effect-AAAAAAAA.js',
      imports: [],
      name: 'router-effect',
    };
    manifest['src/router.tsx'].imports = ['_router-effect-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    markFixtureAppOwnedChunk(root, 'assets/router-effect-AAAAAAAA.js', [
      'src/router-effect.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it.each([
    [
      'callback',
      'import{make}from"./router-effect-AAAAAAAA.js";make()();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>evil;export{make};',
    ],
    [
      'object method',
      'import{make}from"./router-effect-AAAAAAAA.js";make().run();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>({run:evil});export{make};',
    ],
    [
      'array member',
      'import{make}from"./router-effect-AAAAAAAA.js";make()[0]();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>[evil];export{make};',
    ],
    [
      'nested callback',
      'import{make}from"./router-effect-AAAAAAAA.js";make()()();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>()=>evil;export{make};',
    ],
    [
      'nested object method',
      'import{make}from"./router-effect-AAAAAAAA.js";make().create()();',
      'const evil=()=>fetch("https://invalid.example");const make=()=>({create:()=>evil});export{make};',
    ],
    [
      'constructor callback',
      'import{Factory}from"./router-effect-AAAAAAAA.js";(new Factory())();',
      'function Factory(){return()=>fetch("https://invalid.example")}export{Factory};',
    ],
    [
      'constructor object method',
      'import{Factory}from"./router-effect-AAAAAAAA.js";new Factory().run();',
      'function Factory(){return{run:()=>fetch("https://invalid.example")}}export{Factory};',
    ],
    [
      'tagged-template callback',
      'import{tag}from"./router-effect-AAAAAAAA.js";tag``();',
      'const tag=()=>()=>fetch("https://invalid.example");export{tag};',
    ],
    [
      'tagged-template object method',
      'import{tag}from"./router-effect-AAAAAAAA.js";tag``.run();',
      'const tag=()=>({run:()=>fetch("https://invalid.example")});export{tag};',
    ],
  ])(
    'rejects a cross-chunk factory-returned %s load effect',
    (_label, caller, owner) => {
      const root = fixture();
      createCloudflareArtifact(root);
      addCloudflareRouterEffectModule(root, caller, owner);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    }
  );

  it('tracks an explicit callable capture through a cross-chunk factory', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";make(()=>undefined)();',
      'const make=(effect)=>()=>effect();export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'direct imported callback storage',
      'import{store}from"./router-effect-AAAAAAAA.js";store(()=>fetch("https://invalid.example"));',
      'const store=effect=>({effect});export{store};',
    ],
    [
      'factory-result callback storage',
      'import{make}from"./router-effect-AAAAAAAA.js";make().store(()=>fetch("https://invalid.example"));',
      'const make=()=>({store:effect=>({effect})});export{make};',
    ],
    [
      'nested callback storage',
      'import{configure}from"./router-effect-AAAAAAAA.js";configure({onError:()=>fetch("https://invalid.example")});',
      'const configure=options=>({options});export{configure};',
    ],
  ])('keeps a callback dormant through %s', (_label, caller, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'a direct imported consumer',
      'import{consume}from"./router-effect-AAAAAAAA.js";consume(()=>fetch("https://invalid.example"));',
      'const consume=effect=>effect();export{consume};',
    ],
    [
      'an imported factory-result consumer',
      'import{make}from"./router-effect-AAAAAAAA.js";make().consume(()=>fetch("https://invalid.example"));',
      'const make=()=>({consume:effect=>effect()});export{make};',
    ],
    [
      'an imported nested callback consumer',
      'import{configure}from"./router-effect-AAAAAAAA.js";configure({onError:()=>fetch("https://invalid.example")});',
      'const configure=options=>options.onError();export{configure};',
    ],
  ])('rejects a callback invoked by %s', (_label, caller, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('tracks a callback owner through a destructured factory result', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const create=()=>({store:effect=>({effect})}),{store}=create();store(()=>fetch("https://invalid.example"));';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/destructured-factory-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'an imported class instance whose methods remain dormant',
      'import{Runner}from"./router-effect-AAAAAAAA.js";const runner=new Runner();',
      'class Runner{run(){fetch("https://invalid.example")}}export{Runner};',
    ],
    [
      'an imported direct aggregate spread',
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      'const selectors={ready:true};export{selectors};',
    ],
  ])('accepts %s', (_label, caller, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it.each([
    [
      'an imported class constructor effect',
      'import{Runner}from"./router-effect-AAAAAAAA.js";const runner=new Runner();',
      'class Runner{constructor(){fetch("https://invalid.example")}}export{Runner};',
      'must not execute fetch, eval, or worker effects while loading',
    ],
    [
      'an imported aggregate getter',
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      'const selectors={get ready(){fetch("https://invalid.example");return true}};export{selectors};',
      'rejects accessor properties in aggregate spreads',
    ],
    [
      'an imported aggregate with a nested spread',
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      'const base={ready:true},selectors={...base};export{selectors};',
      'requires statically analyzable aggregate spreads',
    ],
  ])('rejects %s', (_label, caller, owner, message) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(root, caller, owner);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(message);
  });

  it.each([
    [
      'a direct live-binding reassignment',
      'let selectors={ready:true};selectors={get ready(){fetch("https://invalid.example");return true}};export{selectors};',
    ],
    [
      'a destructured live-binding reassignment',
      'let selectors={ready:true};({selectors}={selectors:{get ready(){fetch("https://invalid.example");return true}}});export{selectors};',
    ],
  ])('rejects %s before an imported aggregate spread', (_label, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      owner
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it.each([
    [
      'direct definition',
      'const selectors={ready:true};Object.defineProperty(selectors,"ready",{get(){fetch("https://invalid.example");return true}});export{selectors};',
    ],
    [
      'aliased assignment',
      'const selectors={ready:true},alias=selectors;Object.assign(alias,{get ready(){fetch("https://invalid.example");return true}});export{selectors};',
    ],
  ])('rejects imported aggregate mutation by %s', (_label, owner) => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{selectors}from"./router-effect-AAAAAAAA.js";const copy={...selectors};',
      owner
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('keeps an imported Object.assign callable result dormant when stored', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";const handler=make(()=>fetch("https://invalid.example"));',
      'const make=(effect)=>Object.assign(effect,{kind:"handler"});export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('activates an imported Object.assign callable result when invoked', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";make(()=>fetch("https://invalid.example"))();',
      'const make=(effect)=>Object.assign(effect,{kind:"handler"});export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('accepts the provably falsy branch of a logical-and spread', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const maybe=globalThis.optionalFeature&&{ready:true},copy={...maybe};';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/logical-and-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects an opaque logical-or aggregate spread branch', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const clientFile = 'dist/server/assets/client-fixture.js';
    const clientPath = path.join(root, clientFile);
    const prefix =
      'const maybe=globalThis.optionalFeature||globalThis.options,copy={...maybe};';
    write(root, clientFile, `${prefix}${fs.readFileSync(clientPath, 'utf8')}`);
    markFixtureAppOwnedChunk(root, 'assets/client-fixture.js', [
      'src/platform/logical-or-spread-client.ts',
    ]);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable aggregate spreads');
  });

  it('fails closed for a cross-chunk factory result that captures a parameter', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    addCloudflareRouterEffectModule(
      root,
      'import{make}from"./router-effect-AAAAAAAA.js";make()();',
      'const make=(effect=()=>fetch("https://invalid.example"))=>()=>effect();export{make};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('requires statically analyzable cross-chunk factory captures');
  });

  it.each([
    ['non-app', null],
    ['mixed', ['src/router-effect.ts', 'node_modules/example/index.js']],
  ])(
    'deep-scans a factory result returned by an unreviewed %s chunk',
    (_label, modules) => {
      const root = fixture();
      createCloudflareArtifact(root);
      addCloudflareRouterEffectModule(
        root,
        'import{make}from"./router-effect-AAAAAAAA.js";make()();',
        'const evil=()=>fetch("https://invalid.example");const make=()=>evil;export{make};',
        modules
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    }
  );

  it('rejects a side-effecting dynamic target owned by the router entry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `${fs.readFileSync(routerPath, 'utf8')}const loadEvil=()=>import("./router-evil-AAAAAAAA.js");`
    );
    write(
      root,
      'dist/server/assets/router-evil-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-evil-AAAAAAAA.js'] = {
      file: 'assets/router-evil-AAAAAAAA.js',
      imports: [],
      name: 'router-evil',
    };
    manifest['src/router.tsx'].dynamicImports = ['_router-evil-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rejects a nested side-effect import below a dynamic target', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const routerRelativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, routerRelativePath);
    write(
      root,
      routerRelativePath,
      `${fs.readFileSync(routerPath, 'utf8')}const loadEvil=()=>import("./router-evil-AAAAAAAA.js");`
    );
    write(
      root,
      'dist/server/assets/router-evil-AAAAAAAA.js',
      'import"./nested-evil-AAAAAAAA.js";'
    );
    write(
      root,
      'dist/server/assets/nested-evil-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-evil-AAAAAAAA.js'] = {
      file: 'assets/router-evil-AAAAAAAA.js',
      imports: ['_nested-evil-AAAAAAAA.js'],
      name: 'router-evil',
    };
    manifest['_nested-evil-AAAAAAAA.js'] = {
      file: 'assets/nested-evil-AAAAAAAA.js',
      imports: [],
      name: 'nested-evil',
    };
    manifest['src/router.tsx'].dynamicImports = ['_router-evil-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('rejects a substituted startInstance owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={compromised:()=>fetch("https://invalid.example")};export{startInstance};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('rejects a substituted generated route manifest owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
      'const tsrStartManifest=()=>({routes:{compromised:true}});export{tsrStartManifest};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack route manifest shape');
  });

  it('accepts inert TanStack boolean and undefined route-manifest data', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const routeFile = JSON.stringify(path.join(root, 'src/routes/example.tsx'));
    write(
      root,
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},children:void 0,scripts:[{attrs:{async:!0}}]}}});export{tsrStartManifest};`
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('rejects a generated route file outside the active checkout', () => {
    const root = fixture();
    const foreignRoot = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    write(foreignRoot, 'src/routes/example.tsx');
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))}}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(foreignRoot, 'src/routes/example.tsx'))}}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack route manifest shape');
  });

  it('keeps generated route owner digests stable across checkout roots', () => {
    const digestForRoot = (root) => {
      createCloudflareArtifact(root);
      write(root, 'src/routes/example.tsx');
      write(
        root,
        'dist/server/assets/start-AAAAAAAA.js',
        'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
      );
      write(
        root,
        'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
        `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))}}}});export{tsrStartManifest};`
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      return emittedReviewDigest(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      );
    };

    expect(digestForRoot(fixture())).toBe(digestForRoot(fixture()));
  }, 15_000);

  it('pins src/routes-like strings outside the filePath field', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))},children:["/trusted/src/routes/child"]}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))},children:["/evil/src/routes/child"]}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('pins asset-like strings outside reviewed asset-bearing fields', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))},children:["/assets/child-AAAAAAAA.js"]}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );

    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(path.join(root, 'src/routes/example.tsx'))},children:["/assets/child-BBBBBBBB.js"]}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it.each([
    ['a destructive unary value', 'scripts:delete globalThis.fetch'],
    ['a tagged-template value', 'preloads:[fetch`https://invalid.example`]'],
  ])('rejects %s in generated route-manifest data', (_label, fieldSource) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const routeFile = JSON.stringify(path.join(root, 'src/routes/example.tsx'));
    write(
      root,
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},${fieldSource}}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack route manifest shape');
  });

  it('rejects an eager side-effecting start dynamic target', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance=import("./start-evil-AAAAAAAA.js");export{startInstance};'
    );
    write(
      root,
      'dist/server/assets/start-evil-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_start-evil-AAAAAAAA.js'] = {
      file: 'assets/start-evil-AAAAAAAA.js',
      imports: [],
      name: 'start-evil',
    };
    manifest['src/start.ts'].dynamicImports = ['_start-evil-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('pins the implementation closure of a start dynamic target', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={getOptions:async()=>{const{run}=await import("./start-helper-AAAAAAAA.js");return run()}};export{startInstance};'
    );
    write(
      root,
      'dist/server/assets/start-helper-AAAAAAAA.js',
      'const run=()=>undefined;export{run};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_start-helper-AAAAAAAA.js'] = {
      file: 'assets/start-helper-AAAAAAAA.js',
      imports: [],
      name: 'start-helper',
    };
    manifest['src/start.ts'].dynamicImports = ['_start-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      startOwnerClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/start-helper-AAAAAAAA.js',
      'const run=()=>fetch("https://invalid.example");export{run};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('keeps a reviewed dynamic owner stable across content-identical chunk hashes', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    const trustedHelper = 'start-helper-AAAAAAAA.js';
    const replacementHelper = 'start-helper-BBBBBBBB.js';
    write(
      root,
      startPath,
      `const startInstance={getOptions:async()=>{const{run}=await import("./${trustedHelper}");return run()}};export{startInstance};`
    );
    write(
      root,
      `dist/server/assets/${trustedHelper}`,
      'const run=()=>undefined;export{run};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_start-helper-AAAAAAAA.js'] = {
      file: `assets/${trustedHelper}`,
      imports: [],
      name: 'start-helper',
    };
    manifest['src/start.ts'].dynamicImports = ['_start-helper-AAAAAAAA.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      startOwnerClosure,
    };

    write(
      root,
      startPath,
      fs
        .readFileSync(path.join(root, startPath), 'utf8')
        .replace(trustedHelper, replacementHelper)
    );
    write(
      root,
      `dist/server/assets/${replacementHelper}`,
      fs.readFileSync(
        path.join(root, 'dist/server/assets', trustedHelper),
        'utf8'
      )
    );
    fs.rmSync(path.join(root, 'dist/server/assets', trustedHelper));
    delete manifest['_start-helper-AAAAAAAA.js'];
    manifest['_start-helper-BBBBBBBB.js'] = {
      file: `assets/${replacementHelper}`,
      imports: [],
      name: 'start-helper',
    };
    manifest['src/start.ts'].dynamicImports = ['_start-helper-BBBBBBBB.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps a namespace consumer stable across content-identical dependency hashes', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    const sinkPath = 'dist/server/assets/sink-AAAAAAAA.js';
    const trustedHelper = 'sink-helper-AAAAAAAA.js';
    const replacementHelper = 'sink-helper-BBBBBBBB.js';
    write(
      root,
      startPath,
      'import*as consumer from"./sink-AAAAAAAA.js";const startInstance={};consumer.sink(startInstance);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      `import{identity}from"./${trustedHelper}";const sink=(value)=>identity(value);export{sink};`
    );
    write(
      root,
      `dist/server/assets/${trustedHelper}`,
      'const identity=(value)=>value;export{identity};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_sink-AAAAAAAA.js'].imports = ['_sink-helper-AAAAAAAA.js'];
    manifest['_sink-helper-AAAAAAAA.js'] = {
      file: `assets/${trustedHelper}`,
      imports: [],
      name: 'sink-helper',
    };
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      sinkPath,
      fs
        .readFileSync(path.join(root, sinkPath), 'utf8')
        .replace(trustedHelper, replacementHelper)
    );
    write(
      root,
      `dist/server/assets/${replacementHelper}`,
      fs.readFileSync(
        path.join(root, 'dist/server/assets', trustedHelper),
        'utf8'
      )
    );
    fs.rmSync(path.join(root, 'dist/server/assets', trustedHelper));
    delete manifest['_sink-helper-AAAAAAAA.js'];
    manifest['_sink-helper-BBBBBBBB.js'] = {
      file: `assets/${replacementHelper}`,
      imports: [],
      name: 'sink-helper',
    };
    manifest['_sink-AAAAAAAA.js'].imports = ['_sink-helper-BBBBBBBB.js'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('treats build-proven app-only chunks as source-governed owner boundaries', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance=sink({});export{startInstance};'
    );
    addCloudflareSinkModule(root, 'const sink=(value)=>value;export{sink};');
    markFixtureAppOwnedChunk(root, 'assets/sink-AAAAAAAA.js', [
      'src/modules/example/index.ts',
    ]);
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      'const sink=(value)=>({...value});export{sink};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('does not trust an emitted app-source comment as chunk provenance', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance=sink({});export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      '//#region src/modules/example/index.ts\nconst sink=(value)=>value;export{sink};'
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      '//#region src/modules/example/index.ts\nconst sink=(value)=>({...value});export{sink};'
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('isolates large generated owner analysis without weakening its digest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import{sink}from"./sink-AAAAAAAA.js";const startInstance=sink({});export{startInstance};'
    );
    const padding = `/*${'x'.repeat(65_536)}*/`;
    addCloudflareSinkModule(
      root,
      `${padding}const sink=(value)=>value;export{sink};`
    );
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      'dist/server/assets/sink-AAAAAAAA.js',
      `${padding}const sink=(value)=>({...value});export{sink};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed startInstance artifact owner closure');
  });

  it('rejects colliding manifest identities inside a namespace closure', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'import*as consumer from"./sink-AAAAAAAA.js";const startInstance={};consumer.sink(startInstance);export{startInstance};'
    );
    addCloudflareSinkModule(
      root,
      'import{first}from"./sink-helper-AAAAAAAA.js";import{second}from"./sink-helper-BBBBBBBB.js";const sink=(value)=>first(second(value));export{sink};'
    );
    write(
      root,
      'dist/server/assets/sink-helper-AAAAAAAA.js',
      'const first=(value)=>value;export{first};'
    );
    write(
      root,
      'dist/server/assets/sink-helper-BBBBBBBB.js',
      'const second=(value)=>value;export{second};'
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_sink-AAAAAAAA.js'].imports = [
      '_sink-helper-AAAAAAAA.js',
      '_sink-helper-BBBBBBBB.js',
    ];
    manifest['_sink-helper-AAAAAAAA.js'] = {
      file: 'assets/sink-helper-AAAAAAAA.js',
      imports: [],
      name: 'sink-helper',
    };
    manifest['_sink-helper-BBBBBBBB.js'] = {
      file: 'assets/sink-helper-BBBBBBBB.js',
      imports: [],
      name: 'sink-helper',
    };
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(/manifest identity .* maps to both/u);
  });

  it('normalizes a namespace-imported TanStack route manifest', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const startPath = 'dist/server/assets/start-AAAAAAAA.js';
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    const routeManifestSource = (routeFile, firstAsset, secondAsset) =>
      `const tsrStartManifest=()=>({routes:{example:{filePath:${JSON.stringify(routeFile)},preloads:["/assets/${firstAsset}","/assets/${secondAsset}"]}}});export{tsrStartManifest};`;
    write(
      root,
      startPath,
      'import*as routeManifest from"./tanstack-start-manifest-AAAAAAAA.js";const startInstance={load:()=>routeManifest.tsrStartManifest()};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      routeManifestSource(
        path.join(root, 'src/routes/example.tsx'),
        'example-AAAAAAAA.js',
        'presentation-BBBBBBBB.js'
      )
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].imports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedStartOwnerClosure(root);

    write(
      root,
      manifestOwnerPath,
      routeManifestSource(
        path.join(root, 'src/routes/example.tsx'),
        'presentation-DDDDDDDD.js',
        'example-CCCCCCCC.js'
      )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: {
          ...fixtureTanStackOwnerDigests,
          startOwnerClosure,
        },
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps route-manifest asset hashes and preload order out of reviewed owner digests', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const routeFile = JSON.stringify(path.join(root, 'src/routes/example.tsx'));
    const manifestOwnerPath =
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js';
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},preloads:["/assets/example-AAAAAAAA.js","/assets/presentation-CCCCCCCC.js"]}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);
    const startOwnerClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      startOwnerClosure,
    };

    write(
      root,
      manifestOwnerPath,
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},preloads:["/assets/presentation-DDDDDDDD.js","/assets/example-BBBBBBBB.js"]}}});export{tsrStartManifest};`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();
  });

  it('keeps route-manifest preload ordering independent of the ambient locale', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(root, 'src/routes/example.tsx');
    const routeFile = JSON.stringify(path.join(root, 'src/routes/example.tsx'));
    write(
      root,
      'dist/server/assets/start-AAAAAAAA.js',
      'const startInstance={load:()=>import("./tanstack-start-manifest-AAAAAAAA.js")};export{startInstance};'
    );
    write(
      root,
      'dist/server/assets/tanstack-start-manifest-AAAAAAAA.js',
      `const tsrStartManifest=()=>({routes:{example:{filePath:${routeFile},preloads:["/assets/I-AAAAAAAA.js","/assets/i-BBBBBBBB.js"]}}});export{tsrStartManifest};`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/start.ts'].dynamicImports = ['tanstack-start-manifest:v'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(subprocessReviewDigest(root, 'en_US.UTF-8')).toBe(
      subprocessReviewDigest(root, 'tr_TR.UTF-8')
    );
  });

  it('pins a non-literal dynamic import inside a reviewed router owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/router-AAAAAAAA.js',
      'const getRouterCspNonce=(source)=>import(source);function getRouter(){const cspNonce=getRouterCspNonce("node:crypto");return{cspNonce}}export{getRouter};'
    );
    const routerLocalClosure = emittedReviewDigest(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    );
    const reviewedDigests = {
      ...fixtureTanStackOwnerDigests,
      routerLocalClosure,
    };

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).not.toThrow();

    write(
      root,
      'dist/server/assets/router-AAAAAAAA.js',
      'const getRouterCspNonce=(source)=>import(`${source}/promises`);function getRouter(){const cspNonce=getRouterCspNonce("node:fs");return{cspNonce}}export{getRouter};'
    );
    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        cloudflareTanStackOwnerDigests: reviewedDigests,
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('rejects an eager non-literal import outside a reviewed owner', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `${fs.readFileSync(routerPath, 'utf8')}const eagerRuntimeModule=import(globalThis.RUNTIME_MODULE);`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed getRouter artifact owner closure');
  });

  it('rejects a side-effect import owned by the dynamic router entry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/router-effect-AAAAAAAA.js',
      'fetch("https://invalid.example");'
    );
    const relativePath = 'dist/server/assets/router-AAAAAAAA.js';
    const routerPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `import"./router-effect-AAAAAAAA.js";${fs.readFileSync(routerPath, 'utf8')}`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_router-effect-AAAAAAAA.js'] = {
      file: 'assets/router-effect-AAAAAAAA.js',
      imports: [],
      name: 'router-effect',
    };
    manifest['src/router.tsx'].imports.push('_router-effect-AAAAAAAA.js');
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not execute fetch, eval, or worker effects while loading');
  });

  it('reports a missing TanStack dynamic-import manifest list cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    delete manifest['_server-fixture.js'].dynamicImports;
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve its reviewed TanStack dynamic owner graph');
  });

  it('rejects a dynamic import introduced below the reviewed closure root', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/createCsrfMiddleware-AAAAAAAA.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `${fs.readFileSync(chunkPath, 'utf8')}const loadCycle=()=>import("../runtime/cycle-marker-AAAAAAAA.js");`
    );
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['_createCsrfMiddleware-AAAAAAAA.js'].dynamicImports = [
      '_cycle-marker-AAAAAAAA.js',
    ];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack server static import closure');
  });

  it('reports BigInt changes through the reviewed owner diagnostic', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/empty-plugin-adapters-AAAAAAAA.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `const bigintMarker=0n;${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed empty plugin adapters owner');
  });

  it('rejects an unreviewed external inside the reviewed static closure', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/createCsrfMiddleware-AAAAAAAA.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace('import"node:stream"', 'import"unreviewed:runtime"')
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the reviewed TanStack server static import closure');
  });

  it.each([
    [
      'lexical escape',
      '../../outside-BBBBBBBB.js',
      '../outside-BBBBBBBB.js',
      () => {},
      'Cloudflare app-owned provenance coverage',
    ],
    [
      'symlink escape',
      './cycle-marker-BBBBBBBB.js',
      'assets/cycle-marker-BBBBBBBB.js',
      (root) =>
        fs.symlinkSync(
          '../../outside-BBBBBBBB.js',
          path.join(root, 'dist/server/assets/cycle-marker-BBBBBBBB.js')
        ),
      'must be a regular artifact entry',
    ],
  ])(
    'rejects a %s inside the reviewed static closure',
    (
      _label,
      replacementSource,
      replacementFile,
      prepareEscape,
      expectedError
    ) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/outside-BBBBBBBB.js',
        'const serverCycleMarker=false;export{serverCycleMarker};'
      );
      prepareEscape(root);
      replaceManifestStaticEdge(root, {
        ownerFile: 'dist/server/assets/createCsrfMiddleware-AAAAAAAA.js',
        ownerManifestKey: '_createCsrfMiddleware-AAAAAAAA.js',
        replacementEntry: {
          file: replacementFile,
          imports: [],
          name: 'cycle-marker',
        },
        replacementManifestKey: '_cycle-marker-BBBBBBBB.js',
        replacementSource,
        trustedManifestKey: '_cycle-marker-AAAAAAAA.js',
        trustedSource: '../runtime/cycle-marker-AAAAAAAA.js',
      });

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(expectedError);
    }
  );

  it('rejects a substituted React server renderer implementation', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath = 'dist/server/assets/server.edge-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      fs
        .readFileSync(chunkPath, 'utf8')
        .replace(
          'const require_server_edge=()=>({renderToReadableStream})',
          'const require_server_edge=()=>(globalThis.fetch("https://invalid.example"),{renderToReadableStream})'
        )
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must use the reviewed React server renderer static import closure'
    );
  });

  it.each([
    [
      'dist/server/assets/request-failure-fixture.js',
      '_request-failure-fixture.js',
    ],
    [
      'dist/server/assets/request-exception-state-fixture.js',
      '_request-exception-state-fixture.js',
    ],
    [
      'dist/server/assets/request-completion-fixture.js',
      '_request-completion-fixture.js',
    ],
    ['dist/server/assets/telemetry-fixture.js', '_telemetry-fixture.js'],
  ])(
    'rejects a manifest-backed untrusted helper import in %s',
    (relativePath, manifestKey) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/evil.js',
        'fetch("https://invalid.example");'
      );
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        `import"./evil.js";${fs.readFileSync(chunkPath, 'utf8')}`
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['_evil.js'] = {
        file: 'assets/evil.js',
        imports: [],
        name: 'evil',
      };
      manifest[manifestKey].imports.push('_evil.js');
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must import only its trusted static owner chunks');
    }
  );

  it.each([
    [
      'dist/server/assets/create-application-server-entry-fixture.js',
      'src/runtime/create-application-server-entry.ts',
      'must import exactly its trusted helper manifest records',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'must import only its trusted static owner chunks',
    ],
    [
      'dist/server/assets/backend-kernel-fixture.js',
      'src/modules/kernel/backend.ts',
      'must import only its trusted static owner chunks',
    ],
  ])(
    'rejects a manifest-backed untrusted static import in %s',
    (relativePath, manifestKey, expectedMessage) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        'dist/server/assets/evil.js',
        'fetch("https://invalid.example");'
      );
      const chunkPath = path.join(root, relativePath);
      write(
        root,
        relativePath,
        `import"./evil.js";${fs.readFileSync(chunkPath, 'utf8')}`
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      manifest['_evil.js'] = {
        file: 'assets/evil.js',
        imports: [],
        name: 'evil',
      };
      manifest[manifestKey].imports.push('_evil.js');
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(expectedMessage);
    }
  );

  it.each([
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'fetch("https://invalid.example");',
    ],
    [
      'dist/server/assets/backend-kernel-fixture.js',
      'book-fixture.js',
      'book-evil-fixture.js',
      '_book-fixture.js',
      'src/modules/kernel/backend.ts',
      'fetch("https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '(()=>fetch("https://invalid.example"))();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=()=>fetch("https://invalid.example");run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'export const run=()=>fetch("https://invalid.example");run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const fetchOwner=()=>fetch("https://invalid.example");const run=fetchOwner;run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'export default function run(){globalThis["fetch"]("https://invalid.example")}run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=()=>globalThis["fetch"]("https://invalid.example");const alias=(effect);alias();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const box={run(){globalThis["fetch"]("https://invalid.example")}};box.run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '[()=>globalThis["fetch"]("https://invalid.example")][0]();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=()=>globalThis["fetch"]("https://invalid.example");effect.bind(null)();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=globalThis["eval"];effect("void 0");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const Effect=globalThis["Function"];Effect("return undefined")();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '({run:()=>fetch("https://invalid.example")}).run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'globalThis.eval("void 0");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'new Function("return undefined")();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '(0,fetch)("https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'fetch.call(null,"https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'globalThis["fetch"]("https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'new (function(){fetch("https://invalid.example")})();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      '(function(){fetch("https://invalid.example")})`x`;',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=()=>{const effect=globalThis.fetch;effect("https://invalid.example")};run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect=()=>fetch("https://invalid.example"))=>effect();run();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=({effect})=>effect();run({effect:()=>fetch("https://invalid.example")});',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=([effect])=>effect();run([()=>fetch("https://invalid.example")]);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(...effects)=>effects[0]();run(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect)=>{const alias=effect;alias.call(null)};run(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect)=>{const {handler:alias}={handler:effect};new alias()};run(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect)=>{const alias=effect;alias`x`};run(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const inner=({effect})=>effect();const outer=value=>inner({effect:value});outer(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();run.call(null,()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();run.apply(null,[()=>fetch("https://invalid.example")]);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(strings,effect)=>effect();run`x${()=>fetch("https://invalid.example")}`;',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect=()=>fetch("https://invalid.example"))=>effect();run(undefined);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(effect=()=>fetch("https://invalid.example"))=>effect();run(void 0);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=()=>fetch("https://invalid.example"),payload={effect};const run=({effect})=>effect();run(payload);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const effect=()=>fetch("https://invalid.example"),payload=[effect];const run=([effect])=>effect();run(payload);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=options=>options.effect();run({effect:()=>fetch("https://invalid.example")});',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(...effects)=>effects[1]();run(()=>undefined,()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const runner={call(effect){effect()}};runner.call(()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();const invoke=run.call;invoke(null,()=>fetch("https://invalid.example"));',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();const invoke=run.bind(null,()=>fetch("https://invalid.example"));invoke();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=({first,...rest})=>rest.effect();run({first:0,effect:()=>fetch("https://invalid.example")});',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=([first,...rest])=>rest[0]();run([undefined,()=>fetch("https://invalid.example")]);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();const args=[()=>fetch("https://invalid.example")];run(...args);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=effect=>effect();const args=[()=>fetch("https://invalid.example")];run.apply(null,args);',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const key="fetch";globalThis[key]("https://invalid.example");',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const key="run",runner={run:()=>fetch("https://invalid.example")};runner[key]();',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'client-fixture.js',
      'client-evil-fixture.js',
      '_client-fixture.js',
      'src/runtime/cloudflare/database-request.ts',
      'const run=(object,key)=>object[key]();run({danger:()=>fetch("https://invalid.example")},"danger");',
    ],
  ])(
    'rejects a matching-family static chunk substitution in %s (%s -> %s; %s; %s; %s)',
    (
      ownerPath,
      trustedFile,
      substitutedFile,
      manifestKey,
      ownerManifestKey,
      executablePrefix
    ) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const trustedPath = path.join(root, 'dist/server/assets', trustedFile);
      write(
        root,
        `dist/server/assets/${substitutedFile}`,
        `${executablePrefix}${fs.readFileSync(trustedPath, 'utf8')}`
      );
      const ownerFile = path.join(root, ownerPath);
      write(
        root,
        ownerPath,
        fs.readFileSync(ownerFile, 'utf8').replace(trustedFile, substitutedFile)
      );
      const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      const substitutedManifestKey = `_${substitutedFile}`;
      manifest[substitutedManifestKey] = {
        ...manifest[manifestKey],
        file: `assets/${substitutedFile}`,
      };
      const ownerImports = manifest[ownerManifestKey].imports;
      ownerImports.splice(
        ownerImports.indexOf(manifestKey),
        1,
        substitutedManifestKey
      );
      writeJson(root, 'dist/server/.vite/manifest.json', manifest);
      markFixtureAppOwnedChunk(root, `assets/${substitutedFile}`, [
        'src/runtime/cloudflare/reviewed-load-owner.ts',
      ]);

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow(
        'must not execute fetch, eval, or worker effects while loading'
      );
    }
  );

  it.each([
    [
      'dist/server/assets/create-application-server-entry-fixture.js',
      'must import only its trusted static owner chunks',
    ],
    [
      'dist/server/assets/database-request-fixture.js',
      'must import only its trusted static owner chunks',
    ],
    [
      'dist/server/assets/request-failure-fixture.js',
      'must import only its trusted static owner chunks',
    ],
  ])('rejects a detached side-effect import in %s', (relativePath, message) => {
    const root = fixture();
    createCloudflareArtifact(root);
    write(
      root,
      'dist/server/assets/evil.js',
      'fetch("https://invalid.example");'
    );
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `import"./evil.js";${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(message);
  });

  it('rejects a symlink escape from an exact static import graph', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const linkedPath = path.join(root, 'dist/server/assets/react-fixture.js');
    write(root, 'dist/outside-react.js', fs.readFileSync(linkedPath, 'utf8'));
    fs.rmSync(linkedPath);
    fs.symlinkSync('../../outside-react.js', linkedPath);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must be a regular artifact entry');
  });

  it.each([
    [
      'file',
      (root, external) => {
        write(external, 'evil.js', 'fetch("https://invalid.example");');
        fs.symlinkSync(
          path.join(external, 'evil.js'),
          path.join(root, 'dist/server/assets/runtime-plugin.js')
        );
      },
    ],
    [
      'directory',
      (root, external) => {
        write(external, 'evil/entry.js', 'fetch("https://invalid.example");');
        fs.symlinkSync(
          path.join(external, 'evil'),
          path.join(root, 'dist/server/assets/runtime-plugin'),
          'dir'
        );
      },
    ],
  ])(
    'rejects an unmanifested %s symlink after provenance signing',
    (_kind, prepareSymlink) => {
      const root = fixture();
      createCloudflareArtifact(root);
      writeFixtureCloudflareProvenance(root);
      const external = fixture();
      prepareSymlink(root, external);

      expect(() =>
        verifyRuntimeProfileImplementation('cloudflare', root, {
          cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
          cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must be a regular artifact entry');
    }
  );

  it.each(['js', 'map', 'txt'])(
    'rejects an ephemeral provenance key leaked into a .%s artifact',
    (extension) => {
      const root = fixture();
      createCloudflareArtifact(root);
      write(
        root,
        `dist/server/leaked-key.${extension}`,
        fixtureCloudflareProvenanceKey
      );
      writeFixtureCloudflareProvenance(root);

      expect(() =>
        verifyRuntimeProfileImplementation('cloudflare', root, {
          cloudflareAppChunkProvenanceKey: fixtureCloudflareProvenanceKey,
          cloudflareTanStackOwnerDigests: fixtureTanStackOwnerDigests,
          expectedAppSlug: 'acme-app',
          forbiddenArtifactSecrets: [fixtureCloudflareProvenanceKey],
        })
      ).toThrow('contains a build secret');
    }
  );

  it.each([
    ['entry-server', 'tanstack'],
    ['telemetry-entry', 'telemetryProxy'],
  ])('rejects a detached dynamic %s owner chunk', (ownerFile, ownerName) => {
    const root = fixture();
    createCloudflareArtifact(root);
    const sourceRelativePath = `dist/server/assets/${ownerFile}-fixture.js`;
    const sourcePath = path.join(root, sourceRelativePath);
    const decoyFile = `${ownerFile}-decoy.js`;
    write(
      root,
      `dist/server/assets/${decoyFile}`,
      fs.readFileSync(sourcePath, 'utf8')
    );
    const applicationRelativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const applicationPath = path.join(root, applicationRelativePath);
    write(
      root,
      applicationRelativePath,
      fs
        .readFileSync(applicationPath, 'utf8')
        .replace(`${ownerFile}-fixture.js`, decoyFile)
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(`must originate from ${dynamicOwnerSourceNames[ownerName]}`);
  });

  it('rejects a detached application dynamic-import manifest edge', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const manifestPath = path.join(root, 'dist/server/.vite/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest['src/runtime/create-application-server-entry.ts'].dynamicImports =
      ['src/platform/telemetry/index.ts'];
    writeJson(root, 'dist/server/.vite/manifest.json', manifest);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must preserve its exact Vite dynamic import graph');
  });

  it('rejects a shadowed crypto owner in the universal entry', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const relativePath =
      'dist/server/assets/create-application-server-entry-fixture.js';
    const chunkPath = path.join(root, relativePath);
    write(
      root,
      relativePath,
      `const crypto={randomUUID:()=>"fixed"};${fs.readFileSync(chunkPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must use the trusted crypto built-in');
  });

  it.each(['globalThis', 'window', 'global'])(
    'rejects %s access in the Worker entry module',
    (globalAlias) => {
      const root = fixture();
      createCloudflareArtifact(root);
      const entryPath = path.join(root, 'dist/server/index.js');
      write(
        root,
        'dist/server/index.js',
        `${globalAlias}.Response=class{};${fs.readFileSync(entryPath, 'utf8')}`
      );

      expect(() =>
        verifyRuntimeProfile('cloudflare', root, {
          expectedAppSlug: 'acme-app',
        })
      ).toThrow('must not access alternate global built-ins');
    }
  );

  it('rejects an extra top-level Worker module import', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      `await import("./assets/evil.js");${fs.readFileSync(entryPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow(
      'must contain only its bounded Cloudflare module ownership sequence'
    );
  });

  it('reports forbidden Worker Response access accurately', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    const entryPath = path.join(root, 'dist/server/index.js');
    write(
      root,
      'dist/server/index.js',
      `new Response();${fs.readFileSync(entryPath, 'utf8')}`
    );

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must not access the Response built-in');
  });

  it('rejects a non-object Vite manifest cleanly', () => {
    const root = fixture();
    createCloudflareArtifact(root);
    writeJson(root, 'dist/server/.vite/manifest.json', []);

    expect(() =>
      verifyRuntimeProfile('cloudflare', root, {
        expectedAppSlug: 'acme-app',
      })
    ).toThrow('must contain a Vite manifest object');
  });

  it.each([
    [
      'Reflect.apply',
      'const transform=effect=>Reflect.apply(effect,null,[])',
      'effect',
    ],
    [
      'Reflect.construct',
      'const transform=Effect=>Reflect.construct(Effect,[])',
      'Effect',
    ],
    [
      'Function.prototype.call',
      'const transform=effect=>effect.call(null)',
      'effect',
    ],
    [
      'Function.prototype.apply',
      'const transform=effect=>effect.apply(null,[])',
      'effect',
    ],
  ])(
    'classifies a callable parameter invoked through %s',
    (_label, source, name) => {
      expect(
        inspectCloudflareInvokedParameterProjectionsForTesting(
          source,
          'transform'
        )
      ).toEqual([{ name, path: [] }]);
    }
  );

  it.each([
    [
      'Reflect.apply.call',
      'const transform=effect=>Reflect.apply.call(null,effect,null,[])',
      'effect',
    ],
    [
      'Reflect.apply.apply',
      'const transform=effect=>Reflect.apply.apply(null,[effect,null,[]])',
      'effect',
    ],
    [
      'Function.prototype.call.call',
      'const transform=effect=>Function.prototype.call.call(effect,null)',
      'effect',
    ],
    [
      'Function.prototype.apply.call',
      'const transform=effect=>Function.prototype.apply.call(effect,null,[])',
      'effect',
    ],
  ])(
    'classifies a callable parameter invoked through nested %s',
    (_label, source, name) => {
      expect(
        inspectCloudflareInvokedParameterProjectionsForTesting(
          source,
          'transform'
        )
      ).toEqual([{ name, path: [] }]);
    }
  );

  it.each([
    'const target={run:()=>0};function mutate(){target.run=()=>fetch("https://invalid.example")}Reflect.apply(mutate,null,[]);target.run();',
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};Reflect.apply(api.mutate,api,[]);target.run();',
    'const target={run:()=>0};Reflect.construct(class{constructor(){target.run=()=>fetch("https://invalid.example")}},[]);target.run();',
  ])('orders a mutation invoked through Reflect', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0};const api={call(){target.run=()=>fetch("https://invalid.example")}};api.call();target.run();',
    'const target={run:()=>0};const api={apply(){target.run=()=>fetch("https://invalid.example")}};api.apply();target.run();',
  ])(
    'does not confuse a named object method with Function.prototype invocation',
    (source) => {
      expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
        'fetch("https://invalid.example")'
      );
    }
  );

  it.each([
    'const target={run:()=>0};const api={};Object.defineProperty(api,"mutate",{value(){target.run=()=>fetch("https://invalid.example")}});api.mutate();target.run();',
    'const target={run:()=>0};const api={};Object.defineProperty(api,"mutate",{value(){target.run=()=>fetch("https://invalid.example")}});const fn=api.mutate;fn();target.run();',
    'const target={run:()=>0};const api={};Object.defineProperty(api,"mutate",{value(){target.run=()=>fetch("https://invalid.example")}});const {mutate}=api;mutate();target.run();',
    'const target={run:()=>0};const api={};api.mutate=()=>{target.run=()=>fetch("https://invalid.example")};api.mutate();target.run();',
    'const target={run:()=>0};const api={};Object.assign(api,{mutate(){target.run=()=>fetch("https://invalid.example")}});api.mutate();target.run();',
  ])('orders an invoked mutation-installed local method', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0};const api={mutate(){}};api.mutate=()=>{target.run=()=>fetch("https://invalid.example")};api.mutate();target.run();',
    'const target={run:()=>0};const api={mutate(){}};{const api={mutate(){target.run=()=>fetch("https://invalid.example")}};api.mutate()}target.run();',
  ])('uses the execution-site callable owner', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};api.mutate=()=>{};api.mutate();target.run();',
    'const target={run:()=>0};const api={mutate(){target.run=()=>fetch("https://invalid.example")}};{const api={mutate(){}};api.mutate()}target.run();',
  ])('does not invoke a shadowed or overwritten callable owner', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).not.toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const key="run";const api={[key](){fetch("https://invalid.example")}};api.run();',
    'const key="run";class API{[key](){fetch("https://invalid.example")}};new API().run();',
  ])('resolves an immutable computed callable definition', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const key="safe";{const key="run";const api={[key](){fetch("https://invalid.example")}};api.run()}',
    'const key="safe";{const key="run";class API{[key](){fetch("https://invalid.example")}};new API().run()}',
  ])('resolves a shadowed immutable computed callable definition', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toContain(
      'fetch("https://invalid.example")'
    );
  });

  it.each([
    'const key=getKey();const api={[key](){fetch("https://invalid.example")}};api.run();',
    'const key=getKey();class API{[key](){fetch("https://invalid.example")}};new API().run();',
  ])('rejects an opaque computed callable definition', (source) => {
    expect(() => inspectCloudflareLoadEffectsForTesting(source)).toThrow(
      'requires statically analyzable computed callable definitions'
    );
  });

  it.each([
    'globalThis.globalThis.fetch("https://invalid.example")',
    'globalThis.self.fetch("https://invalid.example")',
    'Reflect.get(globalThis,"globalThis").fetch("https://invalid.example")',
    'Object.getOwnPropertyDescriptor(globalThis,"globalThis").value.fetch("https://invalid.example")',
  ])('normalizes a chained global identity alias', (source) => {
    expect(inspectCloudflareLoadEffectsForTesting(source)).toEqual([source]);
  });

  it('rejects unknown profiles', () => {
    expect(() => verifyRuntimeProfile('auto', fixture())).toThrow(
      'unknown profile auto'
    );
  });
});
