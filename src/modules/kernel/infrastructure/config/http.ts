import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
} from './env-schema';

const httpEnvSchema = baseEnvSchema.extend({
  TRUSTED_PROXY_DEPTH: z.preprocess(
    (value) =>
      typeof value === 'string' && value.trim() === '' ? undefined : value,
    z.coerce.number().int().nonnegative().optional()
  ),
});

export type HttpConfig = {
  /**
   * Node-only number of trusted reverse-proxy hops in front of the app. Vercel
   * and Cloudflare use their profile-owned single-value headers instead. Must
   * match the Node deployment topology to avoid trusting attacker-controlled
   * X-Forwarded-For entries. Local/test defaults to `1`; production has no
   * default and fails trusted-IP resolution until explicitly configured.
   * `0` disables Node proxy trust.
   */
  trustedProxyDepth: number | undefined;
};

let cachedHttpConfig: HttpConfig | undefined;

export function getHttpConfig(): HttpConfig {
  if (cachedHttpConfig) return cachedHttpConfig;

  const env = parseEnv(httpEnvSchema);
  cachedHttpConfig = {
    trustedProxyDepth:
      env.TRUSTED_PROXY_DEPTH ??
      (isProdRuntimeEnvironment(env) ? undefined : 1),
  };
  return cachedHttpConfig;
}
