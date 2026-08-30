import type { CloudflareOptions } from '@sentry/cloudflare';

import { createTelemetryAdapterChain } from '@/composition/telemetry/adapter-chain';
import { createSentryTelemetryAdapter } from '@/composition/telemetry/sentry-adapter';
import {
  createCloudflareSentryOptions,
  type CloudflareSentryEnvironment,
} from '@/composition/telemetry/sentry-cloudflare-options';
import {
  assertRequiredTelemetrySignals,
  createTelemetrySignalReadiness,
  isTelemetrySignalRequired,
  parseTelemetryConfig,
} from '@/modules/kernel/backend';
import {
  createNoOpTelemetry,
  reportTelemetryFailure,
  type TelemetryAdapter,
} from '@/platform/telemetry';

import {
  createCloudflareTelemetryAdapter,
  isCloudflareAnalyticsEngine,
  isCloudflareTracing,
  type CloudflareTracing,
} from './telemetry-adapter';

type CloudflareSentryApi = Parameters<typeof createCloudflareSentryOptions>[0] &
  Parameters<typeof createSentryTelemetryAdapter>[0];

export type CloudflareRequestTelemetryEnvironment =
  CloudflareSentryEnvironment &
    Record<string, unknown> & {
      START_UI_TELEMETRY_METRICS?: unknown;
      TELEMETRY_MODE?: unknown;
      TELEMETRY_REQUIRED_SIGNALS?: unknown;
    };

export type CloudflareRequestTelemetryConfiguration = {
  requireSentryOwner: boolean;
  sentryOptions?: CloudflareOptions;
  telemetry: TelemetryAdapter;
};

const unavailableCapabilities = new Set<'metrics' | 'traces'>();

const reportUnavailableCapability = (signal: 'metrics' | 'traces'): void => {
  if (unavailableCapabilities.has(signal)) return;
  unavailableCapabilities.add(signal);
  reportTelemetryFailure(
    `otel.cloudflare.${signal}.unavailable`,
    new Error(`Cloudflare ${signal} capability unavailable`)
  );
};

const parseRequestTelemetryConfig = (
  environment: CloudflareRequestTelemetryEnvironment
) =>
  parseTelemetryConfig({
    PROD: true,
    SENTRY_DSN: environment.SENTRY_DSN,
    TELEMETRY_MODE: environment.TELEMETRY_MODE,
    TELEMETRY_REQUIRED_SIGNALS: environment.TELEMETRY_REQUIRED_SIGNALS,
  });

/**
 * Resolves trusted Worker bindings into one request-local readiness decision.
 * Required capabilities are asserted before the database or application runs.
 */
export const configureCloudflareRequestTelemetry = ({
  environment,
  request,
  sentry,
  sentryRequestIsolationReady,
  tracing,
}: {
  environment: CloudflareRequestTelemetryEnvironment;
  request: Request;
  sentry: CloudflareSentryApi;
  sentryRequestIsolationReady: boolean;
  tracing: CloudflareTracing | unknown;
}): CloudflareRequestTelemetryConfiguration => {
  const config = parseRequestTelemetryConfig(environment);
  let nativeTelemetry = createNoOpTelemetry();
  let nativeTelemetryReady = false;
  let analyticsReady = false;
  let tracingReady = false;

  if (config.mode !== 'off') {
    const analyticsCandidate = environment.START_UI_TELEMETRY_METRICS;
    const analytics = isCloudflareAnalyticsEngine(analyticsCandidate)
      ? analyticsCandidate
      : undefined;
    const requestTracing = isCloudflareTracing(tracing) ? tracing : undefined;
    analyticsReady = analytics !== undefined;
    tracingReady = requestTracing !== undefined;
    if (!analyticsReady) reportUnavailableCapability('metrics');
    if (!tracingReady) reportUnavailableCapability('traces');
    try {
      nativeTelemetry = createCloudflareTelemetryAdapter({
        ...(analytics ? { analytics } : {}),
        ...(requestTracing ? { tracing: requestTracing } : {}),
      });
      nativeTelemetryReady = true;
    } catch (failure) {
      reportTelemetryFailure('otel.cloudflare.configure', failure);
    }
  }

  let sentryOptions: CloudflareOptions | undefined;
  let sentryReady = false;
  let telemetry = nativeTelemetry;
  if (config.dsn && sentryRequestIsolationReady) {
    try {
      sentryOptions = createCloudflareSentryOptions(
        sentry,
        request,
        environment
      );
      const sentryTelemetry = createSentryTelemetryAdapter(sentry, {
        flushOwner: 'request-wrapper',
      });
      telemetry = createTelemetryAdapterChain([
        nativeTelemetry,
        sentryTelemetry,
      ]);
      sentryReady = true;
    } catch (failure) {
      reportTelemetryFailure('sentry.cloudflare.configure', failure);
    }
  }

  assertRequiredTelemetrySignals({
    config,
    phase: 'request',
    profile: 'cloudflare',
    readiness: createTelemetrySignalReadiness({
      exceptions: sentryReady,
      logs: nativeTelemetryReady,
      metrics: nativeTelemetryReady && analyticsReady,
      traces: nativeTelemetryReady && tracingReady,
    }),
  });
  return {
    requireSentryOwner: isTelemetrySignalRequired(config, 'exceptions'),
    ...(sentryOptions ? { sentryOptions } : {}),
    telemetry,
  };
};
