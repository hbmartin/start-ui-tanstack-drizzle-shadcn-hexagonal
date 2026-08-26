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

let initialized = false;

export const runWithNodeSentryRequestIsolation =
  runWithSentryNodeRequestIsolation;

export const initNodeTelemetry = () => {
  if (initialized) return;

  const telemetryConfig = getTelemetryConfig();
  setLocalTelemetrySummaryRecorder(persistLocalTelemetrySummary);
  const requestContext = initializeSentryNodeRequestContext();
  let openTelemetry: ReturnType<typeof initOpenTelemetryServer>;
  if (!telemetryConfig.otelSdkDisabled) {
    try {
      openTelemetry = initOpenTelemetryServer();
    } catch (failure) {
      reportTelemetryFailure('otel.node.initialize', failure);
    }
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
  initialized = true;
};
