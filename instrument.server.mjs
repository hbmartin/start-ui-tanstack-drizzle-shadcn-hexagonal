import * as Sentry from '@sentry/node';

import { sanitizeSentryEvent } from './src/composition/telemetry/sentry-adapter.ts';
import { createExceptionOnlyIntegrations } from './src/composition/telemetry/sentry-exception-integrations.ts';
import { reportTelemetryFailure } from './src/platform/telemetry/report-failure.ts';

const dsn = process.env.SENTRY_DSN;
const environment =
  process.env.VERCEL_ENV ?? process.env.SENTRY_ENVIRONMENT ?? undefined;
const release =
  process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.SENTRY_RELEASE ?? undefined;
const FATAL_FLUSH_TIMEOUT_MS = 2_000;
const instrumentationStateKey = Symbol.for(
  'start-ui-web.telemetry.instrumentation-state'
);
const fatalOwnerReady = Symbol.for('start-ui-web.telemetry.fatal-owner-ready');
const nodeNitroFatalOwner = Symbol.for(
  'start-ui-web.telemetry.node-nitro-fatal-owner'
);
const instrumentationState = globalThis[instrumentationStateKey] ?? {
  fatalExitStarted: false,
  fatalListenerGuard: {
    listener: undefined,
    owned: new Map([
      ['uncaughtException', new Set(process.listeners('uncaughtException'))],
      ['unhandledRejection', new Set(process.listeners('unhandledRejection'))],
    ]),
    suppressedEvents: new Set(),
  },
  handlersInstalled: false,
  sentryInitialized: false,
  sentryReady: false,
};
globalThis[instrumentationStateKey] = instrumentationState;

const reportFatalRuntimeFailure = (source) => {
  try {
    console.error('runtime.fatal', { source });
  } catch {
    // The process is already terminal; never surface the original value here.
  }
};

const exitAfterSentryFlush = (source, failure) => {
  if (instrumentationState.fatalExitStarted) {
    process.exit(1);
    return;
  }
  instrumentationState.fatalExitStarted = true;
  reportFatalRuntimeFailure(source);

  if (!instrumentationState.sentryReady) {
    process.exit(1);
    return;
  }

  try {
    Sentry.captureException(failure, {
      level: 'fatal',
      tags: { event: source },
    });
  } catch (captureFailure) {
    reportTelemetryFailure('sentry.fatal.capture', captureFailure);
  }

  const forcedExit = setTimeout(
    () => process.exit(1),
    FATAL_FLUSH_TIMEOUT_MS + 100
  );
  let close;
  try {
    close = Sentry.close(FATAL_FLUSH_TIMEOUT_MS);
  } catch (closeFailure) {
    clearTimeout(forcedExit);
    reportTelemetryFailure('sentry.fatal.close', closeFailure);
    process.exit(1);
    return;
  }

  void close
    .catch((closeFailure) => {
      reportTelemetryFailure('sentry.fatal.close', closeFailure);
    })
    .finally(() => {
      clearTimeout(forcedExit);
      process.exit(1);
    });
};

const installFatalHandlers = () => {
  if (instrumentationState.handlersInstalled) return;
  instrumentationState.handlersInstalled = true;
  const guard = instrumentationState.fatalListenerGuard;
  globalThis[fatalOwnerReady] = false;

  const uncaughtExceptionHandler = (failure) => {
    exitAfterSentryFlush('runtime.uncaught_exception', failure);
  };
  const unhandledRejectionHandler = (failure) => {
    exitAfterSentryFlush('runtime.unhandled_rejection', failure);
  };
  guard.owned.get('uncaughtException').add(uncaughtExceptionHandler);
  guard.owned.get('unhandledRejection').add(unhandledRejectionHandler);
  process.on('uncaughtException', uncaughtExceptionHandler);
  process.on('unhandledRejection', unhandledRejectionHandler);

  guard.listener = (event, listener) => {
    if (
      (event !== 'uncaughtException' && event !== 'unhandledRejection') ||
      guard.owned.get(event)?.has(listener) ||
      guard.suppressedEvents.has(event)
    ) {
      return;
    }

    guard.suppressedEvents.add(event);
    queueMicrotask(() => {
      process.removeListener(event, listener);
      if (guard.suppressedEvents.size === 2) {
        process.removeListener('newListener', guard.listener);
        globalThis[fatalOwnerReady] = true;
      }
    });
  };

  // Nitro registers one raw-logging handler for each fatal event immediately
  // after this plugin evaluates. Suppress only that bootstrap pair, then
  // detach so later monitoring and cleanup hooks remain possible.
  process.on('newListener', guard.listener);
};

if (globalThis[nodeNitroFatalOwner]) installFatalHandlers();

if (dsn && !instrumentationState.sentryInitialized) {
  instrumentationState.sentryInitialized = true;
  try {
    Sentry.setNodeAsyncContextStrategy();
    const client = Sentry.init({
      beforeSend: sanitizeSentryEvent,
      beforeSendTransaction: () => null,
      defaultIntegrations: false,
      dsn,
      enableLogs: false,
      environment,
      integrations: createExceptionOnlyIntegrations(Sentry),
      registerEsmLoaderHooks: false,
      release,
      sendDefaultPii: false,
      skipOpenTelemetrySetup: true,
      tracePropagationTargets: [],
    });
    instrumentationState.sentryReady = Boolean(client);
  } catch (failure) {
    reportTelemetryFailure('sentry.instrumentation', failure);
  }
}
