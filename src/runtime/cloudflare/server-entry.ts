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

const Sentry = await import('@sentry/cloudflare');
const { initializeCloudflareSentryApplication, runWithCloudflareSentry } =
  await import('./sentry-request');
const { application, sentryRequestIsolationReady } =
  await initializeCloudflareSentryApplication(Sentry, async () => {
    const kernel = await import('@/modules/kernel/backend');
    kernel.validateServerConfig();
    const { createApplicationServerEntry } =
      await import('../create-application-server-entry');
    return createApplicationServerEntry('cloudflare');
  });
const { tracing } = await import('cloudflare:workers');
const { sanitizeSentryEvent, createSentryTelemetryAdapter } =
  await import('@/composition/telemetry/sentry-adapter');
const { createTelemetryAdapterChain } =
  await import('@/composition/telemetry/adapter-chain');
const { setTelemetry } = await import('@/platform/telemetry');
const { createCloudflareTelemetryAdapter } =
  await import('./telemetry-adapter');
const { scheduleCloudflareRequestFlush } = await import('./request-lifecycle');

const createCloudflareSentryOptions = (
  request: Request,
  environment: CloudflareEnvironment
): CloudflareOptions => ({
  beforeSend: (event) =>
    sanitizeSentryEvent({
      ...event,
      request: { method: request.method },
    }),
  dsn: environment.SENTRY_DSN,
  enableLogs: false,
  environment: environment.SENTRY_ENVIRONMENT,
  integrations: [],
  release: environment.SENTRY_RELEASE,
  sendDefaultPii: false,
  skipOpenTelemetrySetup: true,
  tracesSampleRate: 0,
});

const installCloudflareRequestTelemetry = (
  nativeTelemetry: ReturnType<typeof createCloudflareTelemetryAdapter>,
  sentryEnabled: boolean
) => {
  const sentryTelemetry = sentryEnabled
    ? createSentryTelemetryAdapter(Sentry)
    : undefined;
  setTelemetry(
    sentryTelemetry
      ? createTelemetryAdapterChain([nativeTelemetry, sentryTelemetry])
      : nativeTelemetry
  );
};

const fetchCloudflareApplication = ({
  context,
  handle,
  request,
  sentryEnabled,
  sentryOptions,
}: {
  context: CloudflareExecutionContext;
  handle: () => Promise<Response> | Response;
  request: Request;
  sentryEnabled: boolean;
  sentryOptions: CloudflareOptions;
}) =>
  sentryEnabled
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
    const nativeTelemetry = createCloudflareTelemetryAdapter({
      analytics: environment.START_UI_TELEMETRY_METRICS,
      tracing,
    });
    const sentryOptions = createCloudflareSentryOptions(request, environment);
    const sentryEnabled = Boolean(
      environment.SENTRY_DSN && sentryRequestIsolationReady
    );
    installCloudflareRequestTelemetry(nativeTelemetry, sentryEnabled);

    const handle = () =>
      application.fetch(request, { context: undefined as never });
    try {
      return await fetchCloudflareApplication({
        context,
        handle,
        request,
        sentryEnabled,
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
