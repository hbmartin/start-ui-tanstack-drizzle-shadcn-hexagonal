import type { CloudflareOptions } from '@sentry/cloudflare';

import { sanitizeSentryEvent } from './sentry-adapter';

export type CloudflareSentryEnvironment = {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
};

/** Sentry owns exceptions only; OpenTelemetry owns every tracing signal. */
export const createCloudflareSentryOptions = (
  request: Request,
  environment: CloudflareSentryEnvironment
): CloudflareOptions => ({
  beforeSend: (event) =>
    sanitizeSentryEvent({
      ...event,
      request: { method: request.method },
    }),
  beforeSendTransaction: () => null,
  dsn: environment.SENTRY_DSN,
  enableLogs: false,
  environment: environment.SENTRY_ENVIRONMENT,
  integrations: [],
  release: environment.SENTRY_RELEASE,
  sendDefaultPii: false,
  skipOpenTelemetrySetup: true,
  tracesSampler: () => 0,
});
