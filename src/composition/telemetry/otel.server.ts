import { metrics, propagation, trace } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPLogExporter } from '@opentelemetry/exporter-logs-otlp-proto';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
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
  BatchSpanProcessor,
  NodeTracerProvider,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from '@opentelemetry/sdk-trace-node';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import { getTelemetryConfig } from '@/modules/kernel/infrastructure/config/telemetry';
import type { TelemetryAdapter } from '@/platform/telemetry';

import { telemetrySignalUrl } from './collector-url';
import { createOpenTelemetryAdapter } from './otel-adapter';
import { cleanupTelemetryProviders } from './provider-cleanup';
import { claimTelemetryProviderOwnership } from './provider-ownership';

let initialized = false;
let runtime: OpenTelemetryServerRuntime | undefined;

export type OpenTelemetryServerRuntime = {
  adapter: TelemetryAdapter;
  shutdown(): Promise<void>;
};

const createResource = () => {
  const config = getTelemetryConfig();
  return resourceFromAttributes({
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.otelEnvironment,
    [ATTR_SERVICE_NAME]: config.serviceName,
    ...(config.serviceVersion
      ? { [ATTR_SERVICE_VERSION]: config.serviceVersion }
      : {}),
  });
};

const exporterHeaders = () => {
  const { collectorBearerToken } = getTelemetryConfig();
  return collectorBearerToken
    ? { Authorization: `Bearer ${collectorBearerToken}` }
    : undefined;
};

export const initOpenTelemetryServer = ():
  | OpenTelemetryServerRuntime
  | undefined => {
  if (initialized) return runtime;

  const config = getTelemetryConfig();
  if (!config.collectorUrl) {
    initialized = true;
    return undefined;
  }

  let tracerProvider: NodeTracerProvider | undefined;
  let meterProvider: MeterProvider | undefined;
  let loggerProvider: LoggerProvider | undefined;
  try {
    const resource = createResource();
    const headers = exporterHeaders();
    tracerProvider = new NodeTracerProvider({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(config.otelTracesSampleRate),
      }),
      spanProcessors: [
        new BatchSpanProcessor(
          new OTLPTraceExporter({
            headers,
            url: telemetrySignalUrl(config.collectorUrl, 'traces'),
          })
        ),
      ],
    });
    meterProvider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            headers,
            url: telemetrySignalUrl(config.collectorUrl, 'metrics'),
          }),
          exportIntervalMillis: 30_000,
        }),
      ],
      resource,
    });
    loggerProvider = new LoggerProvider({
      processors: [
        new BatchLogRecordProcessor(
          new OTLPLogExporter({
            headers,
            url: telemetrySignalUrl(config.collectorUrl, 'logs'),
          })
        ),
      ],
      resource,
    });
    const candidateAdapter = createOpenTelemetryAdapter({
      forceFlush: async () => {
        await Promise.all([
          tracerProvider!.forceFlush(),
          meterProvider!.forceFlush(),
          loggerProvider!.forceFlush(),
        ]);
      },
    });
    const propagator = new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    });
    const ownedLoggerProvider = loggerProvider;
    const ownedMeterProvider = meterProvider;
    const ownedTracerProvider = tracerProvider;

    const releaseOwnership = claimTelemetryProviderOwnership([
      {
        acquire: () => propagation.setGlobalPropagator(propagator),
        name: 'propagation',
        release: () => propagation.disable(),
      },
      {
        acquire: () =>
          logs.setGlobalLoggerProvider(ownedLoggerProvider) ===
          ownedLoggerProvider,
        name: 'logs',
        release: () => logs.disable(),
      },
      {
        acquire: () => metrics.setGlobalMeterProvider(ownedMeterProvider),
        name: 'metrics',
        release: () => metrics.disable(),
      },
      {
        acquire: () => trace.setGlobalTracerProvider(ownedTracerProvider),
        name: 'trace',
        release: () => trace.disable(),
      },
    ]);

    let shutdownStarted = false;
    runtime = {
      adapter: candidateAdapter,
      shutdown: async () => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        releaseOwnership();
        await cleanupTelemetryProviders('otel.server.shutdown', [
          ownedTracerProvider.shutdown.bind(ownedTracerProvider),
          ownedMeterProvider.shutdown.bind(ownedMeterProvider),
          ownedLoggerProvider.shutdown.bind(ownedLoggerProvider),
        ]);
      },
    };
    initialized = true;
    return runtime;
  } catch (failure) {
    const cleanups: Array<() => Promise<unknown>> = [];
    if (tracerProvider) {
      cleanups.push(tracerProvider.shutdown.bind(tracerProvider));
    }
    if (meterProvider) {
      cleanups.push(meterProvider.shutdown.bind(meterProvider));
    }
    if (loggerProvider) {
      cleanups.push(loggerProvider.shutdown.bind(loggerProvider));
    }
    void cleanupTelemetryProviders('otel.server.cleanup', cleanups);
    throw failure;
  }
};
