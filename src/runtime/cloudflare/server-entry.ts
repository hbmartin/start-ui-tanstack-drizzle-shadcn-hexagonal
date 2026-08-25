import type { ServerEntry } from '@tanstack/react-start/server-entry';
import type { CloudflareOptions } from '@sentry/cloudflare';

import type { CloudflareAnalyticsEngine } from './telemetry-adapter';

type CloudflareEnvironment = {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  START_UI_TELEMETRY_METRICS?: CloudflareAnalyticsEngine;
};

type CloudflareExecutionContext = {
  waitUntil(completion: Promise<unknown>): void;
};

const kernel = await import('@/modules/kernel/backend');
kernel.validateServerConfig();
const Sentry = await import('@sentry/cloudflare');
const { tracing } = await import('cloudflare:workers');
const { sanitizeSentryEvent, createSentryTelemetryAdapter } =
  await import('@/composition/telemetry/sentry-adapter');
const { createTelemetryAdapterChain } =
  await import('@/composition/telemetry/adapter-chain');
const { setTelemetry } = await import('@/platform/telemetry');
const { createCloudflareTelemetryAdapter } =
  await import('./telemetry-adapter');
const { runWithCloudflareSentry } = await import('./sentry-request');
const { scheduleCloudflareRequestFlush } = await import('./request-lifecycle');
const { createApplicationServerEntry } =
  await import('../create-application-server-entry');

const application = await createApplicationServerEntry('cloudflare');

const entry = {
  async fetch(
    request: Request,
    environment: CloudflareEnvironment,
    context: CloudflareExecutionContext
  ) {
    const nativeTelemetry = createCloudflareTelemetryAdapter({
      analytics: environment.START_UI_TELEMETRY_METRICS,
      tracing,
    });
    const sentryOptions: CloudflareOptions = {
      beforeSend: sanitizeSentryEvent,
      dsn: environment.SENTRY_DSN,
      enableLogs: false,
      environment: environment.SENTRY_ENVIRONMENT,
      integrations: [],
      release: environment.SENTRY_RELEASE,
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
      tracesSampleRate: 0,
    };
    const sentryTelemetry = environment.SENTRY_DSN
      ? createSentryTelemetryAdapter(Sentry)
      : undefined;
    setTelemetry(
      sentryTelemetry
        ? createTelemetryAdapterChain([nativeTelemetry, sentryTelemetry])
        : nativeTelemetry
    );

    const handle = () =>
      application.fetch(request, { context: undefined as never });
    try {
      return environment.SENTRY_DSN
        ? await runWithCloudflareSentry({
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
        : await handle();
    } finally {
      scheduleCloudflareRequestFlush(request, (completion) =>
        context.waitUntil(completion)
      );
    }
  },
};

export default entry as unknown as ServerEntry;
