import type { CloudflareOptions } from '@sentry/cloudflare';

import { sanitizeSentryEvent } from './sentry-adapter';
import { createExceptionOnlyIntegrations } from './sentry-exception-integrations';

type CloudflareSentryIntegrationApi = Pick<
  typeof import('@sentry/cloudflare'),
  'eventFiltersIntegration' | 'linkedErrorsIntegration'
>;

export type CloudflareSentryEnvironment = {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
};

/** Sentry owns exceptions only; OpenTelemetry owns every tracing signal. */
export const createCloudflareSentryOptions = (
  Sentry: CloudflareSentryIntegrationApi,
  request: Request,
  environment: CloudflareSentryEnvironment
): CloudflareOptions => ({
  beforeSend: (event) =>
    sanitizeSentryEvent({
      ...event,
      request: { method: request.method },
    }),
  beforeSendTransaction: () => null,
  defaultIntegrations: false,
  dsn: environment.SENTRY_DSN,
  enableLogs: false,
  environment: environment.SENTRY_ENVIRONMENT,
  integrations: createExceptionOnlyIntegrations(Sentry),
  release: environment.SENTRY_RELEASE,
  sendDefaultPii: false,
  skipOpenTelemetrySetup: true,
  tracePropagationTargets: [],
});
