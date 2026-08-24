/* oxlint-disable no-process-env */

export type RuntimeEnv = Record<string, unknown>;

const isTruthy = (value: unknown) => value === true || value === 'true';

/**
 * Read runtime configuration with deploy-time values taking precedence over
 * Vite's build-time snapshot. This keeps build-once/deploy-many artifacts from
 * being pinned to the environment that produced them.
 */
export const readRuntimeEnv = (source?: RuntimeEnv): RuntimeEnv => {
  if (source) return source;

  const viteEnv = (import.meta as ImportMeta & { env?: RuntimeEnv }).env ?? {};
  const processEnv =
    typeof process === 'undefined' ? {} : (process.env as RuntimeEnv);

  return { ...viteEnv, ...processEnv };
};

export const isProdRuntimeEnvironment = (source?: RuntimeEnv) => {
  const env = readRuntimeEnv(source);
  const nodeEnv =
    typeof env.NODE_ENV === 'string'
      ? env.NODE_ENV.trim().toLowerCase()
      : undefined;

  if (nodeEnv === 'development' || nodeEnv === 'test') return false;
  if (nodeEnv === 'production') return true;
  return isTruthy(env.PROD);
};

export const isDevRuntimeEnvironment = (source?: RuntimeEnv) => {
  const env = readRuntimeEnv(source);
  const nodeEnv =
    typeof env.NODE_ENV === 'string'
      ? env.NODE_ENV.trim().toLowerCase()
      : undefined;

  if (nodeEnv) return nodeEnv === 'development';
  return isTruthy(env.DEV);
};
