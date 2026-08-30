import { z } from 'zod';

import {
  telemetryModes,
  telemetrySignals,
  type TelemetryMode,
  type TelemetrySignal,
} from '@/platform/telemetry';

import {
  baseEnvSchema,
  isProdRuntimeEnvironment,
  parseEnv,
} from './env-schema';
import type { RuntimeEnv } from '@/platform/env/runtime';
import { assertSecureUrlInProduction } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

const LOCAL_TELEMETRY_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

const telemetrySignalSet = new Set<string>(telemetrySignals);

const requiredTelemetrySignalsSchema = z
  .string()
  .trim()
  .optional()
  .transform((value, context): ReadonlyArray<TelemetrySignal> => {
    if (value === undefined) return [];

    const requestedSignals = value.split(',').map((signal) => signal.trim());
    const invalidSignals = requestedSignals.filter(
      (signal) => signal.length === 0 || !telemetrySignalSet.has(signal)
    );
    if (invalidSignals.length > 0) {
      context.addIssue({
        code: 'custom',
        message:
          'Expected a comma-separated subset of traces, metrics, logs, exceptions.',
      });
      return z.NEVER;
    }

    const requestedSignalSet = new Set(requestedSignals);
    return telemetrySignals.filter((signal) => requestedSignalSet.has(signal));
  });

const stripIpv6Brackets = (value: string) =>
  value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;

const isLocalTelemetryUrl = (value: string) => {
  try {
    return LOCAL_TELEMETRY_HOSTS.has(
      stripIpv6Brackets(new URL(value).hostname)
    );
  } catch {
    return false;
  }
};

const telemetryEnvSchema = baseEnvSchema.extend({
  SENTRY_DSN: z.string().url().optional(),
  VITE_SENTRY_DSN: z.string().url().optional(),
  SENTRY_ENVIRONMENT: z.string().optional(),
  SENTRY_ORG: z.string().optional(),
  SENTRY_PROJECT: z.string().optional(),
  SENTRY_AUTH_TOKEN: z.string().optional(),
  OTEL_COLLECTOR_URL: z.string().url().optional(),
  OTEL_COLLECTOR_BEARER_TOKEN: z.string().optional(),
  OTEL_SERVICE_NAME: z.string().optional(),
  OTEL_SERVICE_VERSION: z.string().optional(),
  OTEL_ENVIRONMENT: z.string().optional(),
  TELEMETRY_MODE: z.enum(telemetryModes).optional(),
  TELEMETRY_REQUIRED_SIGNALS: requiredTelemetrySignalsSchema,
  OTEL_SDK_DISABLED: z
    .string()
    .optional()
    .transform((value) => value?.trim().toLowerCase() === 'true'),
  OTEL_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).optional(),
  OTEL_LOCAL_SQLITE_ENABLED: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => (value === undefined ? undefined : value === 'true')),
  OTEL_LOCAL_SQLITE_PATH: z.string().optional(),
  TELEMETRY_PROXY_MAX_BYTES: z.coerce.number().int().positive().optional(),
  TELEMETRY_LOG_MAX_EVENTS: z.coerce.number().int().positive().optional(),
  TELEMETRY_RATE_LIMIT_PER_MINUTE: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
  TELEMETRY_REQUIRE_AUTH: z.stringbool().default(false),
});

export type TelemetryConfig = {
  mode: TelemetryMode;
  requiredSignals: ReadonlyArray<TelemetrySignal>;
  dsn?: string;
  browserDsn?: string;
  environment?: string;
  org?: string;
  project?: string;
  authToken?: string;
  collectorUrl?: string;
  collectorBearerToken?: string;
  serviceName: string;
  serviceVersion?: string;
  otelEnvironment?: string;
  otelSdkDisabled: boolean;
  otelTracesSampleRate: number;
  localSqliteEnabled: boolean;
  localSqlitePath: string;
  proxyMaxBytes: number;
  logMaxEvents: number;
  rateLimitPerMinute: number;
  requireAuth: boolean;
};

let cachedTelemetryConfig: TelemetryConfig | undefined;

export function parseTelemetryConfig(source?: RuntimeEnv): TelemetryConfig {
  const env = parseEnv(telemetryEnvSchema, source);
  const isProduction = isProdRuntimeEnvironment(env);
  const mode = env.TELEMETRY_MODE ?? 'optional';
  if (env.OTEL_SDK_DISABLED && mode !== 'off') {
    throw new ConfigurationError(
      'OTEL_SDK_DISABLED=true conflicts with TELEMETRY_MODE. Set TELEMETRY_MODE=off explicitly.'
    );
  }
  if (mode === 'required' && env.TELEMETRY_REQUIRED_SIGNALS.length === 0) {
    throw new ConfigurationError(
      'TELEMETRY_MODE=required requires at least one TELEMETRY_REQUIRED_SIGNALS value.'
    );
  }
  if (mode !== 'required' && env.TELEMETRY_REQUIRED_SIGNALS.length > 0) {
    throw new ConfigurationError(
      'TELEMETRY_REQUIRED_SIGNALS may only be set when TELEMETRY_MODE=required.'
    );
  }
  if (
    isProduction &&
    env.OTEL_COLLECTOR_URL &&
    new URL(env.OTEL_COLLECTOR_URL).protocol !== 'https:' &&
    !isLocalTelemetryUrl(env.OTEL_COLLECTOR_URL)
  ) {
    throw new ConfigurationError(
      'OTEL_COLLECTOR_URL must use HTTPS in production unless it targets localhost.'
    );
  }
  assertSecureUrlInProduction({
    name: 'SENTRY_DSN',
    value: env.SENTRY_DSN,
    env,
  });
  assertSecureUrlInProduction({
    name: 'VITE_SENTRY_DSN',
    value: env.VITE_SENTRY_DSN,
    env,
  });

  return {
    mode,
    requiredSignals: env.TELEMETRY_REQUIRED_SIGNALS,
    dsn: env.SENTRY_DSN,
    browserDsn: env.VITE_SENTRY_DSN ?? env.SENTRY_DSN,
    environment: env.SENTRY_ENVIRONMENT,
    org: env.SENTRY_ORG,
    project: env.SENTRY_PROJECT,
    authToken: env.SENTRY_AUTH_TOKEN,
    collectorUrl: env.OTEL_COLLECTOR_URL,
    collectorBearerToken: env.OTEL_COLLECTOR_BEARER_TOKEN,
    serviceName: env.OTEL_SERVICE_NAME ?? 'start-ui-web',
    serviceVersion: env.OTEL_SERVICE_VERSION,
    otelEnvironment:
      env.OTEL_ENVIRONMENT ??
      env.SENTRY_ENVIRONMENT ??
      (isProduction ? 'production' : 'local'),
    otelSdkDisabled: mode === 'off',
    otelTracesSampleRate: env.OTEL_TRACES_SAMPLE_RATE ?? 1,
    localSqliteEnabled: env.OTEL_LOCAL_SQLITE_ENABLED ?? !isProduction,
    localSqlitePath:
      env.OTEL_LOCAL_SQLITE_PATH ?? '.telemetry/telemetry.sqlite',
    proxyMaxBytes: env.TELEMETRY_PROXY_MAX_BYTES ?? 1_000_000,
    logMaxEvents: env.TELEMETRY_LOG_MAX_EVENTS ?? 50,
    rateLimitPerMinute: env.TELEMETRY_RATE_LIMIT_PER_MINUTE ?? 600,
    requireAuth: env.TELEMETRY_REQUIRE_AUTH,
  };
}

export function getTelemetryConfig(): TelemetryConfig {
  cachedTelemetryConfig ??= parseTelemetryConfig();
  return cachedTelemetryConfig;
}
