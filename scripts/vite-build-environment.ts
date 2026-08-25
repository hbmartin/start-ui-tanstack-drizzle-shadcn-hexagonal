import { loadEnv } from 'vite';

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
    env: loadEnv(mode, envDir, 'VITE_'),
    envDir,
  } as const;
};
