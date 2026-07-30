import { z } from 'zod';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
} from './env-schema';

const PLACEHOLDER_OUTBOX_SECRET_VALUES = new Set([
  'changeme',
  'change-me',
  'change_me',
  'replace me',
  'secret',
  'drain-secret',
]);

const isPlaceholderOutboxSecret = (value: string) =>
  PLACEHOLDER_OUTBOX_SECRET_VALUES.has(value.trim().toLowerCase());

const outboxEnvSchema = baseEnvSchema
  .extend({
    OUTBOX_DRAIN_SECRET: z.string().trim().min(1).optional(),
    OUTBOX_DRAIN_BATCH_SIZE: z.coerce.number().int().positive().optional(),
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().positive().optional(),
    OUTBOX_BASE_BACKOFF_SECONDS: z.coerce.number().int().positive().optional(),
  })
  .superRefine((env, ctx) => {
    if (!isProdRuntimeEnvironment(env)) return;

    if (
      env.OUTBOX_DRAIN_SECRET &&
      isPlaceholderOutboxSecret(env.OUTBOX_DRAIN_SECRET)
    ) {
      ctx.addIssue({
        code: 'custom',
        path: ['OUTBOX_DRAIN_SECRET'],
        message:
          'OUTBOX_DRAIN_SECRET must not use a placeholder value in production',
      });
    }
  });

export type OutboxConfig = {
  /** Bearer secret for the drain route; the route is disabled when unset. */
  drainSecret?: string;
  drainBatchSize: number;
  maxAttempts: number;
  baseBackoffMs: number;
};

let cachedOutboxConfig: OutboxConfig | undefined;

export function getOutboxConfig(): OutboxConfig {
  if (cachedOutboxConfig) return cachedOutboxConfig;

  const env = parseEnv(outboxEnvSchema);
  cachedOutboxConfig = {
    drainSecret: env.OUTBOX_DRAIN_SECRET,
    drainBatchSize: env.OUTBOX_DRAIN_BATCH_SIZE ?? 20,
    maxAttempts: env.OUTBOX_MAX_ATTEMPTS ?? 8,
    baseBackoffMs: (env.OUTBOX_BASE_BACKOFF_SECONDS ?? 30) * 1000,
  };
  return cachedOutboxConfig;
}
