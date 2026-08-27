import { loadEnv } from 'vite';

const BUILD_CONFIGURATION_PREFIXES = [
  'APP_DOMAIN',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_URL',
  'VITE_',
];

export type ViteBuildEnvironmentOptions = Readonly<{
  isolated: boolean;
  mode: string;
  root: string;
}>;

export const loadViteBuildEnvironment = ({
  isolated,
  mode,
  root,
}: ViteBuildEnvironmentOptions) => {
  const envDir = isolated ? false : root;
  return {
    env: loadEnv(mode, envDir, BUILD_CONFIGURATION_PREFIXES),
    envDir,
  } as const;
};
