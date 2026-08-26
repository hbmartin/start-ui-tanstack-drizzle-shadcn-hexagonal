import * as Sentry from '@sentry/node';

import { initOpenTelemetryServer } from '@/composition/telemetry/otel.server';
import { persistLocalTelemetrySummary } from '@/composition/telemetry/local-sqlite-sink';
import { setLocalTelemetrySummaryRecorder } from '@/composition/telemetry/local-summary';
import {
  initializeSentryNodeRequestContext,
  runWithSentryNodeRequestIsolation,
} from '@/composition/telemetry/sentry-node-request-context';
import { installServerTelemetry } from '@/composition/telemetry/sentry.server';
import { getTelemetryConfig } from '@/modules/kernel/backend';
import { reportTelemetryFailure } from '@/platform/telemetry';

import {
  createPersistentTelemetryRuntime,
  installPersistentTelemetryLifecycle,
} from './process-lifecycle';

let initialization: Promise<void> | undefined;

export const runWithNodeSentryRequestIsolation =
  runWithSentryNodeRequestIsolation;

const initNodeTelemetry = async () => {
  const telemetryConfig = getTelemetryConfig();
  setLocalTelemetrySummaryRecorder(persistLocalTelemetrySummary);
  const requestContext = await initializeSentryNodeRequestContext();
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

  const installedTelemetry = installServerTelemetry({
    openTelemetry: openTelemetry?.adapter,
    sentry: telemetryConfig.dsn && requestContext ? Sentry : undefined,
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
