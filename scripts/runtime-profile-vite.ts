import { createHash, createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ConfigEnv, Plugin } from 'vite';

import {
  parseRuntimeProfile,
  type RuntimeProfile,
} from '../src/platform/runtime/runtime-profile.js';

export const RUNTIME_PROFILE_ENV_KEY = 'START_UI_RUNTIME_PROFILE';
export const RUNTIME_SERVER_ENTRY_MODULE =
  'virtual:start-ui/runtime-server-entry';

const resolvedRuntimeServerEntryModule = `\0${RUNTIME_SERVER_ENTRY_MODULE}`;

export const runtimeServerEntryPaths = {
  cloudflare: 'src/runtime/cloudflare/server-entry.ts',
  node: 'src/runtime/node/server-entry.ts',
  vercel: 'src/runtime/vercel/server-entry.ts',
} as const satisfies Readonly<Record<RuntimeProfile, string>>;

export const cloudflareVitePluginOptions = {
  configPath: './wrangler.json',
  remoteBindings: false,
  viteEnvironment: { name: 'ssr' },
} as const;

export const cloudflareAppChunkProvenanceFile =
  'start-ui-app-chunk-provenance.json';
export const cloudflareAppChunkProvenanceKeyEnvironment =
  'START_UI_CLOUDFLARE_PROVENANCE_KEY';

type CloudflareOutputChunk = Readonly<{
  code: string;
  dynamicImports?: ReadonlyArray<string>;
  fileName: string;
  imports?: ReadonlyArray<string>;
  modules: Readonly<Record<string, unknown>>;
  type: 'chunk';
}>;

export const isPathWithinDirectory = (
  candidate: string,
  directory: string,
  pathImplementation: Pick<
    typeof path,
    'isAbsolute' | 'relative' | 'sep'
  > = path
) => {
  const relative = pathImplementation.relative(directory, candidate);
  return (
    relative !== '..' &&
    !relative.startsWith(`..${pathImplementation.sep}`) &&
    !pathImplementation.isAbsolute(relative)
  );
};

const isWithinDirectory = (candidate: string, directory: string) =>
  isPathWithinDirectory(candidate, directory);

const resolvedBuildModuleFile = (moduleId: string) => {
  if (moduleId.startsWith('\0')) return undefined;
  const queryIndex = moduleId.indexOf('?');
  const file = queryIndex === -1 ? moduleId : moduleId.slice(0, queryIndex);
  if (!path.isAbsolute(file)) return undefined;
  try {
    return {
      lexicalFile: path.normalize(file),
      file: fs.realpathSync.native(file),
      query: queryIndex === -1 ? '' : moduleId.slice(queryIndex),
    };
  } catch {
    return undefined;
  }
};

const opaqueCloudflareModuleId = (moduleId: string, root: string) => {
  const queryIndex = moduleId.indexOf('?');
  const rawFile = queryIndex === -1 ? moduleId : moduleId.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : moduleId.slice(queryIndex);
  const stableInput =
    path.isAbsolute(rawFile) && isWithinDirectory(rawFile, root)
      ? `root:${path.relative(root, rawFile).split(path.sep).join('/')}${query}`
      : `opaque:${moduleId}`;
  return `non-app:${createHash('sha256').update(stableInput).digest('hex')}`;
};

const cloudflareBuildModuleProvenance = (
  moduleId: string,
  root: string,
  sourceRoot: string,
  realRoot: string,
  realSourceRoot: string
) => {
  const resolved = resolvedBuildModuleFile(moduleId);
  if (!resolved) {
    return {
      id: opaqueCloudflareModuleId(moduleId, root),
      owner: 'non-app' as const,
    };
  }
  if (
    !isWithinDirectory(resolved.lexicalFile, sourceRoot) ||
    !isWithinDirectory(resolved.file, realSourceRoot)
  ) {
    const relative = path.relative(realRoot, resolved.file);
    const id =
      !isWithinDirectory(resolved.lexicalFile, root) ||
      relative.startsWith('..')
        ? opaqueCloudflareModuleId(moduleId, root)
        : `${relative.split(path.sep).join('/')}${resolved.query}`;
    return { id, owner: 'non-app' as const };
  }
  return {
    id: `${path.relative(realRoot, resolved.file).split(path.sep).join('/')}${resolved.query}`,
    owner: 'app' as const,
  };
};

const compareCloudflareModuleIds = (
  left: Readonly<{ id: string }>,
  right: Readonly<{ id: string }>
) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);

const compareCloudflareChunkEntries = (
  [left]: readonly [string, unknown],
  [right]: readonly [string, unknown]
) => (left < right ? -1 : left > right ? 1 : 0);

const cloudflareChunkOwnership = (
  modules: ReadonlyArray<Readonly<{ owner: 'app' | 'non-app' }>>
) => {
  const appModules = modules.filter(({ owner }) => owner === 'app').length;
  if (modules.length > 0 && appModules === modules.length) return 'app-only';
  return appModules > 0 ? 'mixed' : 'non-app';
};

const cloudflareOutputChunkProvenance = (
  chunk: CloudflareOutputChunk,
  outputChunkFiles: ReadonlySet<string>,
  root: string,
  sourceRoot: string,
  realRoot: string,
  realSourceRoot: string
) => {
  const modules = Object.keys(chunk.modules)
    .map((moduleId) =>
      cloudflareBuildModuleProvenance(
        moduleId,
        root,
        sourceRoot,
        realRoot,
        realSourceRoot
      )
    )
    .sort(compareCloudflareModuleIds);
  return [
    chunk.fileName,
    {
      dynamicImports: (chunk.dynamicImports ?? [])
        .filter((file) => outputChunkFiles.has(file))
        .sort(),
      imports: (chunk.imports ?? [])
        .filter((file) => outputChunkFiles.has(file))
        .sort(),
      modules,
      ownership: cloudflareChunkOwnership(modules),
      sha256: createHash('sha256').update(chunk.code).digest('hex'),
    },
  ] as const;
};

const isCloudflareOutputChunk = (
  output: unknown
): output is CloudflareOutputChunk =>
  typeof output === 'object' &&
  output !== null &&
  (output as { type?: unknown }).type === 'chunk';

export const createCloudflareAppChunkProvenance = (
  root: string,
  bundle: Readonly<Record<string, unknown>>
) => {
  const lexicalRoot = path.resolve(root);
  const lexicalSourceRoot = path.join(lexicalRoot, 'src');
  const realRoot = fs.realpathSync.native(lexicalRoot);
  const realSourceRoot = fs.realpathSync.native(path.join(realRoot, 'src'));
  const outputChunks = Object.values(bundle).filter(isCloudflareOutputChunk);
  const outputChunkFiles = new Set(
    outputChunks.map(({ fileName }) => fileName)
  );
  const chunks = outputChunks
    .map((chunk) =>
      cloudflareOutputChunkProvenance(
        chunk,
        outputChunkFiles,
        lexicalRoot,
        lexicalSourceRoot,
        realRoot,
        realSourceRoot
      )
    )
    .sort(compareCloudflareChunkEntries);
  return { chunks: Object.fromEntries(chunks), version: 1 } as const;
};

const decodeCloudflareAppChunkProvenanceKey = (key: string) => {
  const decoded = Buffer.from(key, 'base64url');
  if (decoded.length !== 32 || decoded.toString('base64url') !== key) {
    throw new Error(
      `${cloudflareAppChunkProvenanceKeyEnvironment} must be a canonical 256-bit base64url key`
    );
  }
  return decoded;
};

export const createCloudflareAppChunkProvenanceEnvelope = (
  provenance: ReturnType<typeof createCloudflareAppChunkProvenance>,
  key?: string
) => {
  const payload = Buffer.from(JSON.stringify(provenance)).toString('base64url');
  if (!key) {
    return { algorithm: 'none', payload, signature: null, version: 1 } as const;
  }
  const signature = createHmac(
    'sha256',
    decodeCloudflareAppChunkProvenanceKey(key)
  )
    .update(payload)
    .digest('base64url');
  return { algorithm: 'hmac-sha256', payload, signature, version: 1 } as const;
};

export const createCloudflareAppChunkProvenancePlugin = (
  root: string,
  key?: string
): Plugin => ({
  name: 'start-ui:cloudflare-app-chunk-provenance',
  apply: 'build',
  applyToEnvironment: (environment) => environment.name === 'ssr',
  enforce: 'post',
  generateBundle(_options, bundle) {
    if (!key) return;
    this.emitFile({
      fileName: cloudflareAppChunkProvenanceFile,
      source: `${JSON.stringify(
        createCloudflareAppChunkProvenanceEnvelope(
          createCloudflareAppChunkProvenance(root, bundle),
          key
        ),
        null,
        2
      )}\n`,
      type: 'asset',
    });
  },
});

export const resolveViteRuntimeProfile = (
  config: Pick<ConfigEnv, 'command'>,
  value: unknown
): RuntimeProfile => {
  if (value !== undefined && value !== '') return parseRuntimeProfile(value);
  if (config.command === 'serve') return 'node';
  throw new Error(
    `${RUNTIME_PROFILE_ENV_KEY} is required for production builds. Use pnpm build:node, pnpm build:vercel, or pnpm build:cloudflare.`
  );
};

export const shouldInstallNodeNitroFatalOwner = (
  config: Pick<ConfigEnv, 'command'>,
  profile: RuntimeProfile
) => config.command === 'build' && profile === 'node';

export const createCanonicalOriginVitePlugin = (
  canonicalOrigin: string
): Plugin => ({
  name: 'start-ui:canonical-origin',
  configResolved(config) {
    // Vite expands whole-object import.meta.env reads from config.env. Mutate
    // the resolved allowlist so client and SSR bundles consume the same
    // profile-selected origin that startup validation approved.
    config.env.VITE_BASE_URL = canonicalOrigin;
  },
});

export const createRuntimeServerEntrySource = ({
  profile,
  root,
}: {
  profile: RuntimeProfile;
  root: string;
}) =>
  `export { default } from ${JSON.stringify(
    path.resolve(root, runtimeServerEntryPaths[profile])
  )};`;

export const runtimeServerEntryPlugin = ({
  profile,
  root,
}: {
  profile: RuntimeProfile;
  root: string;
}): Plugin => ({
  name: 'start-ui:runtime-server-entry',
  resolveId(id) {
    return id === RUNTIME_SERVER_ENTRY_MODULE
      ? resolvedRuntimeServerEntryModule
      : undefined;
  },
  load(id) {
    if (id !== resolvedRuntimeServerEntryModule) return undefined;
    return createRuntimeServerEntrySource({ profile, root });
  },
});
