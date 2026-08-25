import { z } from 'zod';

import { baseEnvSchema, parseEnv } from './env-schema';

const httpEnvSchema = baseEnvSchema.extend({
  TRUSTED_PROXY_DEPTH: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().int().nonnegative().optional()
  ),
});

export type HttpConfig = {
  /**
   * Number of trusted reverse-proxy hops in front of the app. Used to read the
   * genuine client IP from `X-Forwarded-For` (see `getClientIp`). Must match the
   * deployment topology to avoid trusting attacker-supplied entries. Defaults to
   * `1` (a single trusted edge/proxy). Depth `0` explicitly disables all
   * proxy-header trust for a directly exposed origin.
   */
  trustedProxyDepth: number;
};

let cachedHttpConfig: HttpConfig | undefined;

export function getHttpConfig(): HttpConfig {
  if (cachedHttpConfig) return cachedHttpConfig;

  const env = parseEnv(httpEnvSchema);
  cachedHttpConfig = {
    trustedProxyDepth: env.TRUSTED_PROXY_DEPTH ?? 1,
  };
  return cachedHttpConfig;
}
