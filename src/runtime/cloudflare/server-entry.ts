import type { ServerEntry } from '@tanstack/react-start/server-entry';
import type { CloudflareOptions } from '@sentry/cloudflare';

import type { CloudflareSentryEnvironment } from '@/composition/telemetry/sentry-cloudflare-options';
import type { HyperdriveBinding } from '@/modules/kernel/backend';

import type { CloudflareAnalyticsEngine } from './telemetry-adapter';

type CloudflareEnvironment = CloudflareSentryEnvironment & {
  START_UI_DATABASE: HyperdriveBinding;
  START_UI_TELEMETRY_METRICS?: CloudflareAnalyticsEngine;
};

type CloudflareExecutionContext = {
  waitUntil(completion: Promise<unknown>): void;
};

const Sentry = await import('@sentry/cloudflare');
const { initializeCloudflareSentryApplication, runWithCloudflareSentry } =
  await import('./sentry-request');
const { application, sentryRequestIsolationReady } =
  await initializeCloudflareSentryApplication(Sentry, async () => {
    const kernel = await import('@/modules/kernel/backend');
    kernel.requireRuntimeDatabaseClient();
    kernel.validateServerBuildConfig('cloudflare');
    const { createApplicationServerEntry } =
      await import('../create-application-server-entry');
    return createApplicationServerEntry('cloudflare');
  });
const { tracing } = await import('cloudflare:workers');
const { createNoOpTelemetry, reportTelemetryFailure } =
  await import('@/platform/telemetry');
const { createCloudflareTelemetryAdapter } =
  await import('./telemetry-adapter');
const { runWithCloudflareDatabase } = await import('./database-request');
const { configureCloudflareRequestTelemetry } =
  await import('./request-telemetry');
const { scheduleCloudflareRequestFlush } = await import('./request-lifecycle');
let lastKnownNativeTelemetry = createNoOpTelemetry();

const fetchCloudflareApplication = ({
  context,
  handle,
  request,
  sentryOptions,
}: {
  context: CloudflareExecutionContext;
  handle: () => Promise<Response> | Response;
  request: Request;
  sentryOptions?: CloudflareOptions;
}) =>
  sentryOptions
    ? runWithCloudflareSentry({
        api: Sentry,
        handle,
        request,
        requestOptions: {
          captureErrors: false,
          context: context as never,
          options: sentryOptions,
          request: request as never,
        },
      })
    : handle();

const entry = {
  async fetch(
    request: Request,
    environment: CloudflareEnvironment,
    context: CloudflareExecutionContext
  ) {
    let nativeTelemetry = lastKnownNativeTelemetry;
    try {
      nativeTelemetry = createCloudflareTelemetryAdapter({
        analytics: environment.START_UI_TELEMETRY_METRICS,
        tracing,
      });
      lastKnownNativeTelemetry = nativeTelemetry;
    } catch (failure) {
      reportTelemetryFailure('otel.cloudflare.configure', failure);
    }
    const { sentryOptions } = configureCloudflareRequestTelemetry({
      environment,
      nativeTelemetry,
      request,
      sentry: Sentry,
      sentryRequestIsolationReady,
    });

    const handleApplication = () =>
      application.fetch(request, { context: undefined as never });
    const handleDatabase = () =>
      runWithCloudflareDatabase({
        binding: environment.START_UI_DATABASE,
        handle: handleApplication,
        request,
      });
    try {
      return await fetchCloudflareApplication({
        context,
        handle: handleDatabase,
        request,
        sentryOptions,
      });
    } finally {
      scheduleCloudflareRequestFlush(request, (completion) =>
        context.waitUntil(completion)
      );
    }
  },
};

export default entry as unknown as ServerEntry;
