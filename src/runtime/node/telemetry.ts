import * as Sentry from '@sentry/node';

import { initOpenTelemetryServer } from '@/composition/telemetry/otel.server';
import { persistLocalTelemetrySummary } from '@/composition/telemetry/local-sqlite-sink';
import { setLocalTelemetrySummaryRecorder } from '@/composition/telemetry/local-summary';
import {
  initializeSentryNodeRequestContext,
  runWithSentryNodeRequestIsolation,
} from '@/composition/telemetry/sentry-node-request-context';
import { installServerTelemetry } from '@/composition/telemetry/sentry.server';
import {
  assertRequiredTelemetrySignals,
  createTelemetrySignalReadiness,
  getTelemetryConfig,
} from '@/modules/kernel/backend';
import {
  isServerSentryInstrumentationReady,
  reportTelemetryFailure,
} from '@/platform/telemetry';

import {
  createPersistentTelemetryRuntime,
  installPersistentTelemetryLifecycle,
} from './process-lifecycle';

let initialization: Promise<void> | undefined;

export const runWithNodeSentryRequestIsolation =
  runWithSentryNodeRequestIsolation;

const initNodeTelemetry = async () => {
  const telemetryConfig = getTelemetryConfig();
  if (telemetryConfig.mode !== 'off') {
    setLocalTelemetrySummaryRecorder(persistLocalTelemetrySummary);
  }
  let requestContext: Awaited<
    ReturnType<typeof initializeSentryNodeRequestContext>
  >;
  try {
    requestContext = await initializeSentryNodeRequestContext();
  } catch (failure) {
    reportTelemetryFailure('sentry.node.context_initialize', failure);
  }
  let openTelemetry: ReturnType<typeof initOpenTelemetryServer>;
  if (!telemetryConfig.otelSdkDisabled && requestContext) {
    try {
      openTelemetry = initOpenTelemetryServer();
    } catch (failure) {
      reportTelemetryFailure('otel.node.initialize', failure);
    }
  } else if (!telemetryConfig.otelSdkDisabled) {
    reportTelemetryFailure(
      'otel.node.context_unavailable',
      new Error('A functional async context owner is required')
    );
  }

  const sentryReady = Boolean(
    telemetryConfig.dsn &&
    requestContext &&
    isServerSentryInstrumentationReady()
  );
  try {
    assertRequiredTelemetrySignals({
      config: telemetryConfig,
      phase: 'initialization',
      profile: 'node',
      readiness: createTelemetrySignalReadiness({
        exceptions: sentryReady,
        logs: Boolean(openTelemetry),
        metrics: Boolean(openTelemetry),
        traces: Boolean(openTelemetry),
      }),
    });
  } catch (failure) {
    try {
      await openTelemetry?.shutdown();
    } catch (cleanupFailure) {
      reportTelemetryFailure('otel.node.required_cleanup', cleanupFailure);
    }
    try {
      requestContext?.release();
    } catch (cleanupFailure) {
      reportTelemetryFailure('sentry.node.required_cleanup', cleanupFailure);
    }
    throw failure;
  }

  const installedTelemetry = installServerTelemetry({
    openTelemetry: openTelemetry?.adapter,
    sentry: sentryReady ? Sentry : undefined,
  });
  const shutdownProviders =
    openTelemetry || requestContext
      ? async () => {
          try {
            await openTelemetry?.shutdown();
          } finally {
            requestContext?.release();
          }
        }
      : undefined;
  const persistentRuntime = createPersistentTelemetryRuntime({
    telemetry: installedTelemetry,
    shutdownProviders,
  });
  if (persistentRuntime) {
    installPersistentTelemetryLifecycle(persistentRuntime);
  }
};

const initializeNodeTelemetryOnce = (): Promise<void> => {
  initialization ??= initNodeTelemetry();
  return initialization;
};

export { initializeNodeTelemetryOnce as initNodeTelemetry };
