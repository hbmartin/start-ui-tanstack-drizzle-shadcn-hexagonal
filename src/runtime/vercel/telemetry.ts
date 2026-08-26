import { logs } from '@opentelemetry/api-logs';
import { metrics } from '@opentelemetry/api';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchLogRecordProcessor,
  LoggerProvider,
} from '@opentelemetry/sdk-logs';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-base';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';
import * as Sentry from '@sentry/node';
import { registerOTel } from '@vercel/otel';

import { telemetrySignalUrl } from '@/composition/telemetry/collector-url';
import { createOpenTelemetryAdapter } from '@/composition/telemetry/otel-adapter';
import { cleanupTelemetryProviders } from '@/composition/telemetry/provider-cleanup';
import { claimTelemetryProviderOwnership } from '@/composition/telemetry/provider-ownership';
import {
  claimSentryNodeRequestContext,
  createSentryNodeRequestContextManager,
  isSentryNodeRequestContextActive,
  runWithSentryNodeRequestIsolation,
  type SentryNodeRequestContextManager,
} from '@/composition/telemetry/sentry-node-request-context';
import { installServerTelemetry } from '@/composition/telemetry/sentry.server';
import {
  getTelemetryConfig,
  runWithNormalizedOtelSdkEnvironment,
  type TelemetryConfig,
} from '@/modules/kernel/backend';
import { reportTelemetryFailure } from '@/platform/telemetry';

let initialized = false;

export const runWithVercelSentryRequestIsolation =
  runWithSentryNodeRequestIsolation;

const exporterHeaders = (bearerToken: string | undefined) =>
  bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined;

const initializeTraceOwner = (
  config: TelemetryConfig,
  contextManager: SentryNodeRequestContextManager | undefined
): { requestContextReady: boolean; traceOwnerReady: boolean } => {
  if (config.otelSdkDisabled) {
    return {
      requestContextReady: Boolean(
        contextManager && claimSentryNodeRequestContext(contextManager)
      ),
      traceOwnerReady: false,
    };
  }

  try {
    runWithNormalizedOtelSdkEnvironment(() =>
      registerOTel({
        ...(contextManager ? { contextManager } : {}),
        instrumentations: [],
        serviceName: config.serviceName,
        traceExporter: 'auto',
        traceSampler: new ParentBasedSampler({
          root: new TraceIdRatioBasedSampler(config.otelTracesSampleRate),
        }),
      })
    );
    return {
      requestContextReady: Boolean(
        contextManager && isSentryNodeRequestContextActive(contextManager)
      ),
      traceOwnerReady: true,
    };
  } catch (failure) {
    reportTelemetryFailure('otel.vercel.traces.initialize', failure);
    return {
      requestContextReady: Boolean(
        contextManager &&
        claimSentryNodeRequestContext(contextManager, {
          acceptAlreadyInstalledByProvider: true,
        })
      ),
      traceOwnerReady: false,
    };
  }
};

const createSignalResource = (config: TelemetryConfig) =>
  resourceFromAttributes({
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.otelEnvironment,
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.serviceVersion
      ? { [ATTR_SERVICE_VERSION]: config.serviceVersion }
      : {}),
  });

const createLoggerProvider = (config: TelemetryConfig) =>
  new LoggerProvider({
    processors: [
      new BatchLogRecordProcessor(
        new OTLPLogExporter({
          headers: exporterHeaders(config.collectorBearerToken),
          url: telemetrySignalUrl(config.collectorUrl!, 'logs'),
        })
      ),
    ],
    resource: createSignalResource(config),
  });

const createMeterProvider = (config: TelemetryConfig) =>
  new MeterProvider({
    readers: [
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({
          headers: exporterHeaders(config.collectorBearerToken),
          url: telemetrySignalUrl(config.collectorUrl!, 'metrics'),
        }),
        exportIntervalMillis: 30_000,
      }),
    ],
    resource: createSignalResource(config),
  });

type SignalOwners = {
  logger?: LoggerProvider;
  meter?: MeterProvider;
  ready: boolean;
};

const cleanupSignalOwners = (owners: SignalOwners) => {
  const cleanups = [owners.logger, owners.meter]
    .filter((provider) => provider !== undefined)
    .map((provider) => provider.shutdown.bind(provider));
  void cleanupTelemetryProviders('otel.vercel.signals.cleanup', cleanups);
};

const initializeSignalOwners = (config: TelemetryConfig): SignalOwners => {
  const owners: SignalOwners = { ready: false };
  if (!config.collectorUrl) return owners;

  try {
    owners.logger = createLoggerProvider(config);
    owners.meter = createMeterProvider(config);
    const loggerProvider = owners.logger;
    const meterProvider = owners.meter;
    claimTelemetryProviderOwnership([
      {
        acquire: () =>
          logs.setGlobalLoggerProvider(loggerProvider) === loggerProvider,
        name: 'logs',
        release: () => logs.disable(),
      },
      {
        acquire: () => metrics.setGlobalMeterProvider(meterProvider),
        name: 'metrics',
        release: () => metrics.disable(),
      },
    ]);
    owners.ready = true;
  } catch (failure) {
    cleanupSignalOwners(owners);
    reportTelemetryFailure('otel.vercel.signals.initialize', failure);
  }
  return owners;
};

export const initVercelTelemetry = () => {
  if (initialized) return;

  const config = getTelemetryConfig();
  const contextManager = createSentryNodeRequestContextManager();
  const { requestContextReady, traceOwnerReady } = initializeTraceOwner(
    config,
    contextManager
  );
  const signalOwners = config.otelSdkDisabled
    ? { logger: undefined, meter: undefined, ready: false }
    : initializeSignalOwners(config);

  const openTelemetry =
    traceOwnerReady || signalOwners.ready
      ? createOpenTelemetryAdapter({
          forceFlush: async () => {
            await Promise.all([
              signalOwners.logger?.forceFlush(),
              signalOwners.meter?.forceFlush(),
            ]);
          },
        })
      : undefined;
  installServerTelemetry({
    openTelemetry,
    sentry: config.dsn && requestContextReady ? Sentry : undefined,
  });
  initialized = true;
};
