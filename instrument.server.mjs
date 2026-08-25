import * as Sentry from '@sentry/node';

import { sanitizeSentryEvent } from './src/composition/telemetry/sentry-adapter.ts';
import { reportTelemetryFailure } from './src/platform/telemetry/report-failure.ts';

const dsn = process.env.SENTRY_DSN;
const environment =
  process.env.VERCEL_ENV ?? process.env.SENTRY_ENVIRONMENT ?? undefined;
const release =
  process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.SENTRY_RELEASE ?? undefined;

if (dsn) {
  try {
    Sentry.init({
      beforeSend: sanitizeSentryEvent,
      dsn,
      enableLogs: false,
      environment,
      registerEsmLoaderHooks: false,
      release,
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
    });
  } catch (failure) {
    reportTelemetryFailure('sentry.instrumentation', failure);
  }
}
