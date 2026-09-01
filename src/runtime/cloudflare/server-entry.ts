import type { ServerEntry } from '@tanstack/react-start/server-entry';
import type { CloudflareOptions } from '@sentry/cloudflare';

import type { HyperdriveBinding } from '@/modules/kernel/backend';

import type { CloudflareRequestTelemetryEnvironment } from './request-telemetry';

type CloudflareEnvironment = CloudflareRequestTelemetryEnvironment & {
  START_UI_DATABASE: HyperdriveBinding;
};

type CloudflareExecutionContext = {
  waitUntil(completion: Promise<unknown>): void;
};

const {
  initializeCloudflareTelemetryRequestScope,
  runWithCloudflareTelemetry,
} = await import('./telemetry-request-scope');
initializeCloudflareTelemetryRequestScope();
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
const { runWithCloudflareDatabase } = await import('./database-request');
const { configureCloudflareRequestTelemetry } =
  await import('./request-telemetry');
const { scheduleCloudflareRequestFlush } = await import('./request-lifecycle');
const fetchCloudflareApplication = ({
  context,
  handle,
  request,
  requireSentryOwner,
  sentryOptions,
}: {
  context: CloudflareExecutionContext;
  handle: () => Promise<Response> | Response;
  request: Request;
  requireSentryOwner: boolean;
  sentryOptions?: CloudflareOptions;
}) =>
  sentryOptions
    ? runWithCloudflareSentry({
        api: Sentry,
        handle,
        request,
        requireSentryOwner,
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
    const { requireSentryOwner, sentryOptions, telemetry } =
      configureCloudflareRequestTelemetry({
        environment,
        request,
        sentry: Sentry,
        sentryRequestIsolationReady,
        tracing,
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
      return await runWithCloudflareTelemetry(telemetry, () =>
        fetchCloudflareApplication({
          context,
          handle: handleDatabase,
          request,
          requireSentryOwner,
          sentryOptions,
        })
      );
    } finally {
      scheduleCloudflareRequestFlush(request, telemetry, (completion) =>
        context.waitUntil(completion)
      );
    }
  },
};

export default entry as unknown as ServerEntry;
