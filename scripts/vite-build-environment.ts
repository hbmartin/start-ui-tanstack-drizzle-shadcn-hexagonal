import { loadEnv } from 'vite';

import {
  telemetryModes,
  type TelemetryMode,
} from '../src/platform/telemetry/mode.js';

const BUILD_CONFIGURATION_PREFIXES = [
  'APP_DOMAIN',
  'VERCEL_PROJECT_PRODUCTION_URL',
  'VERCEL_URL',
  'VITE_',
];
const TELEMETRY_MODE_ENVIRONMENT = 'TELEMETRY_MODE';

const parseBuildTelemetryMode = (value: string | undefined): TelemetryMode => {
  if (value === undefined) return 'optional';
  const telemetryMode = telemetryModes.find((mode) => mode === value);
  if (telemetryMode) return telemetryMode;
  throw new TypeError(
    `${TELEMETRY_MODE_ENVIRONMENT} must be one of ${telemetryModes.join(', ')}.`
  );
};

const exactBuildEnvironment = (environment: Record<string, string>) =>
  Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) =>
        !key.startsWith(TELEMETRY_MODE_ENVIRONMENT) ||
        key === TELEMETRY_MODE_ENVIRONMENT
    )
  );

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
  const loadedEnvironment = loadEnv(mode, envDir, [
    ...BUILD_CONFIGURATION_PREFIXES,
    TELEMETRY_MODE_ENVIRONMENT,
  ]);
  const telemetryMode = parseBuildTelemetryMode(
    loadedEnvironment[TELEMETRY_MODE_ENVIRONMENT]
  );
  return {
    env: exactBuildEnvironment(loadedEnvironment),
    envDir,
    telemetryMode,
  } as const;
};
