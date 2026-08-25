import * as Sentry from '@sentry/node';

import { initOpenTelemetryServer } from '@/composition/telemetry/otel.server';
import { persistLocalTelemetrySummary } from '@/composition/telemetry/local-sqlite-sink';
import { setLocalTelemetrySummaryRecorder } from '@/composition/telemetry/local-summary';
import { installServerTelemetry } from '@/composition/telemetry/sentry.server';
import { getTelemetryConfig } from '@/modules/kernel/backend';
import { reportTelemetryFailure } from '@/platform/telemetry';

import {
  createPersistentTelemetryRuntime,
  installPersistentTelemetryLifecycle,
} from './process-lifecycle';

let initialized = false;

export const initNodeTelemetry = () => {
  if (initialized) return;

  const telemetryConfig = getTelemetryConfig();
  setLocalTelemetrySummaryRecorder(persistLocalTelemetrySummary);
  let openTelemetry: ReturnType<typeof initOpenTelemetryServer>;
  try {
    openTelemetry = initOpenTelemetryServer();
  } catch (failure) {
    reportTelemetryFailure('otel.node.initialize', failure);
  }

  const installedTelemetry = installServerTelemetry({
    openTelemetry: openTelemetry?.adapter,
    sentry: telemetryConfig.dsn ? Sentry : undefined,
  });
  const persistentRuntime = createPersistentTelemetryRuntime({
    telemetry: installedTelemetry,
    shutdownProviders: openTelemetry?.shutdown,
  });
  if (persistentRuntime) {
    installPersistentTelemetryLifecycle(persistentRuntime);
  }
  initialized = true;
};
