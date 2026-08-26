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
