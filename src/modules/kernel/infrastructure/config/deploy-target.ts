import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
} from './env-schema';

/**
 * Resend restricts tag values to ASCII letters, numbers, underscores, and
 * dashes, so the canonical deploy target is constrained to the same alphabet
 * and can be stamped on any provider without re-encoding.
 */
const DEPLOY_TARGET_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

const deployTargetEnvSchema = baseEnvSchema.extend({
  DEPLOY_TARGET: z
    .string()
    .trim()
    .toLowerCase()
    .regex(DEPLOY_TARGET_PATTERN, {
      message:
        'DEPLOY_TARGET must start with a letter or number and contain only lowercase letters, numbers, underscores, or dashes',
    })
    .optional(),
  VITE_ENV_NAME: z.string().optional(),
});

export type DeployTargetConfig = {
  deployTarget: string;
};

const slugifyEnvName = (value: string) => {
  const slug = value
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9_-]+/g, '-')
    .replaceAll(/^[_-]+|[_-]+$/g, '');
  return DEPLOY_TARGET_PATTERN.test(slug) ? slug : undefined;
};

let cachedDeployTargetConfig: DeployTargetConfig | undefined;

/**
 * Canonical server-side environment identifier. An explicit `DEPLOY_TARGET`
 * wins; otherwise production runtimes derive `production` and non-production
 * runtimes derive a slug from `VITE_ENV_NAME` (falling back to `local`).
 * Outbound external calls are stamped with this value and inbound webhooks
 * carrying a different one are dropped (see `checkDeployTarget`).
 */
export function getDeployTargetConfig(): DeployTargetConfig {
  if (cachedDeployTargetConfig) return cachedDeployTargetConfig;

  const env = parseEnv(deployTargetEnvSchema);
  const derived = isProdRuntimeEnvironment(env)
    ? 'production'
    : ((env.VITE_ENV_NAME === undefined
        ? undefined
        : slugifyEnvName(env.VITE_ENV_NAME)) ?? 'local');

  cachedDeployTargetConfig = {
    deployTarget: env.DEPLOY_TARGET ?? derived,
  };
  return cachedDeployTargetConfig;
}
