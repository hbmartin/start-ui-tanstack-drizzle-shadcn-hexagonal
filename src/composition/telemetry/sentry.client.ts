import * as Sentry from '@sentry/tanstackstart-react';

import { envClient } from '@/platform/env/client';
import {
  reportTelemetryFailure,
  type TelemetryAdapter,
} from '@/platform/telemetry';

import { createTelemetryAdapterChain } from './adapter-chain';
import { setTelemetry } from './index';
import { initOpenTelemetryClient } from './otel.client';
import {
  createSentryTelemetryAdapter,
  sanitizeSentryEvent,
} from './sentry-adapter';
import { createExceptionOnlyIntegrations } from './sentry-exception-integrations';

let initialized = false;

/**
 * Initialize Sentry for the browser runtime. Safe to call multiple times.
 *
 * No-op when `VITE_SENTRY_DSN` is unset so previews/local dev keep working
 * without telemetry configuration.
 */
const isTelemetryAdapter = (
  adapter: TelemetryAdapter | undefined
): adapter is TelemetryAdapter => Boolean(adapter);

export const createBrowserSentryOptions = () => ({
  beforeSend: sanitizeSentryEvent,
  beforeSendTransaction: () => null,
  defaultIntegrations: false as const,
  dsn: envClient.VITE_SENTRY_DSN,
  enableLogs: false,
  environment: envClient.VITE_SENTRY_ENVIRONMENT,
  integrations: createExceptionOnlyIntegrations(Sentry, [
    Sentry.functionToStringIntegration(),
    Sentry.browserApiErrorsIntegration(),
    Sentry.globalHandlersIntegration({
      onerror: true,
      onunhandledrejection: true,
    }),
  ]),
  sendDefaultPii: false,
  tracePropagationTargets: [],
  tunnel: envClient.VITE_SENTRY_TUNNEL_PATH,
});

export const initTelemetryClient = (_router?: unknown) => {
  if (initialized) return;
  initialized = true;

  let otelAdapter: TelemetryAdapter | undefined;
  if (envClient.TELEMETRY_MODE !== 'off') {
    try {
      otelAdapter = initOpenTelemetryClient();
    } catch (failure) {
      reportTelemetryFailure('otel.client.initialize', failure);
    }
  }
  const adapters = [otelAdapter].filter(isTelemetryAdapter);

  if (!envClient.VITE_SENTRY_DSN) {
    if (adapters.length > 0) {
      setTelemetry(createTelemetryAdapterChain(adapters));
    }
    return;
  }

  try {
    Sentry.init(createBrowserSentryOptions());

    adapters.push(
      createSentryTelemetryAdapter(Sentry, {
        currentCorrelation: () => otelAdapter?.currentCorrelation() ?? {},
      })
    );
  } catch (failure) {
    reportTelemetryFailure('sentry.client.initialize', failure);
  }
  if (adapters.length > 0) {
    setTelemetry(createTelemetryAdapterChain(adapters));
  }
};
