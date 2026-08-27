/* oxlint-disable no-process-env */
import { z } from 'zod';

import { applicationIdentitySchema } from './application-identity';
import { resolveCanonicalOrigin } from './canonical-origin';
import type { RuntimeProfile } from '../runtime/runtime-profile';

import {
  isDevRuntimeEnvironment,
  isProdRuntimeEnvironment,
  readRuntimeEnv,
  type RuntimeEnv,
} from './runtime';
import {
  httpsInProductionMessage,
  isSecureUrlForProduction,
} from './url-security';

const isTruthy = (value: unknown) => value === true || value === 'true';

const emptyStringAsUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

export const isDevEnvironment = isDevRuntimeEnvironment;

const clientSchema = (isProduction: boolean, isDevelopment: boolean) =>
  applicationIdentitySchema.extend({
    VITE_BASE_URL: z.url(),
    VITE_AUTH_SIGNUP_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .prefault('false')
      .transform((value) => value === 'true'),
    VITE_VISUAL_TEST: z
      .enum(['true', 'false'])
      .optional()
      .prefault('false')
      .transform((value) => value === 'true'),
    DEV: z
      .union([z.boolean(), z.string()])
      .optional()
      .transform((value) =>
        value === undefined ? isDevelopment : isTruthy(value)
      ),
    VITE_ENV_NAME: z
      .string()
      .optional()
      .transform((value) => value ?? (isDevelopment ? 'LOCAL' : undefined)),
    VITE_ENV_EMOJI: z
      .emoji()
      .optional()
      .transform((value) => value ?? (isDevelopment ? '🚧' : undefined)),
    VITE_ENV_COLOR: z
      .string()
      .optional()
      .transform((value) => value ?? (isDevelopment ? 'gold' : 'plum')),
    VITE_S3_BUCKET_PUBLIC_URL: z.preprocess(
      emptyStringAsUndefined,
      z
        .url()
        .refine((value) => isSecureUrlForProduction(value, isProduction), {
          message: httpsInProductionMessage('VITE_S3_BUCKET_PUBLIC_URL'),
        })
        .optional()
    ),
    VITE_SENTRY_DSN: z
      .string()
      .url()
      .refine((value) => isSecureUrlForProduction(value, isProduction), {
        message: httpsInProductionMessage('VITE_SENTRY_DSN'),
      })
      .optional(),
    VITE_SENTRY_ENVIRONMENT: z.string().optional(),
    VITE_OTEL_BROWSER_ENABLED: z
      .enum(['true', 'false'])
      .optional()
      .prefault('true')
      .transform((value) => value === 'true'),
    VITE_OTEL_SERVICE_NAME: z.string().optional().prefault('start-ui-web'),
    VITE_OTEL_SERVICE_VERSION: z.string().optional(),
    VITE_OTEL_ENVIRONMENT: z.string().optional(),
    VITE_OTEL_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).prefault(1),
    VITE_TELEMETRY_DEBUG_RAW_VALUES: z
      .enum(['true', 'false'])
      .optional()
      .prefault('false')
      .transform((value) => value === 'true'),
    VITE_SENTRY_TUNNEL_PATH: z
      .string()
      .optional()
      .prefault('/api/telemetry/sentry-tunnel'),
  });

export type EnvClient = z.infer<ReturnType<typeof clientSchema>>;

export const parseClientEnv = (
  raw: RuntimeEnv,
  runtimeProfile?: RuntimeProfile
): EnvClient =>
  clientSchema(
    isProdRuntimeEnvironment(raw),
    isDevRuntimeEnvironment(raw)
  ).parse({
    ...raw,
    VITE_BASE_URL: resolveCanonicalOrigin(raw, runtimeProfile),
  });

let cachedClientEnv: EnvClient | undefined;
let cachedRuntimeProfile: RuntimeProfile | undefined;

export function getEnvClient(runtimeProfile?: RuntimeProfile): EnvClient {
  if (cachedClientEnv && runtimeProfile === undefined) return cachedClientEnv;
  if (cachedClientEnv && cachedRuntimeProfile === runtimeProfile) {
    return cachedClientEnv;
  }
  if (cachedRuntimeProfile && runtimeProfile !== cachedRuntimeProfile) {
    throw new TypeError(
      `Client configuration was already initialized for the ${cachedRuntimeProfile} runtime profile.`
    );
  }
  const raw = readRuntimeEnv();
  if (
    runtimeProfile === undefined &&
    typeof window === 'undefined' &&
    isProdRuntimeEnvironment(raw)
  ) {
    throw new TypeError(
      'Production server client configuration requires an explicit RuntimeProfile.'
    );
  }
  cachedClientEnv = parseClientEnv(raw, runtimeProfile);
  cachedRuntimeProfile = runtimeProfile;
  return cachedClientEnv;
}

export const envClient = new Proxy({} as EnvClient, {
  get: (_target, property: keyof EnvClient) => getEnvClient()[property],
});
