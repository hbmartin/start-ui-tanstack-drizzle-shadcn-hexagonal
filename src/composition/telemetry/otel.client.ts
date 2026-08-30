import { context, metrics, propagation, trace } from '@opentelemetry/api';
import { ZoneContextManager } from '@opentelemetry/context-zone';
import {
  CompositePropagator,
  W3CBaggagePropagator,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-proto';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  WebTracerProvider,
} from '@opentelemetry/sdk-trace-web';
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from '@opentelemetry/semantic-conventions';

import { envClient } from '@/platform/env/client';
import type { TelemetryAdapter } from '@/platform/telemetry';

import { createOpenTelemetryAdapter } from './otel-adapter';
import { cleanupTelemetryProviders } from './provider-cleanup';
import { claimTelemetryProviderOwnership } from './provider-ownership';

let initialized = false;
let adapter: TelemetryAdapter | undefined;

const createClientResource = () =>
  resourceFromAttributes({
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]:
      envClient.VITE_OTEL_ENVIRONMENT ??
      envClient.VITE_SENTRY_ENVIRONMENT ??
      envClient.VITE_ENV_NAME ??
      'local',
    [ATTR_SERVICE_NAME]: envClient.VITE_OTEL_SERVICE_NAME,
    ...(envClient.VITE_OTEL_SERVICE_VERSION
      ? { [ATTR_SERVICE_VERSION]: envClient.VITE_OTEL_SERVICE_VERSION }
      : {}),
  });

export const initOpenTelemetryClient = (): TelemetryAdapter | undefined => {
  if (initialized) return adapter;
  initialized = true;

  if (
    envClient.TELEMETRY_MODE === 'off' ||
    !envClient.VITE_OTEL_BROWSER_ENABLED
  ) {
    return undefined;
  }

  let provider: WebTracerProvider | undefined;
  let meterProvider: MeterProvider | undefined;
  let contextManager: ZoneContextManager | undefined;

  try {
    const resource = createClientResource();
    const traceExporter = new OTLPTraceExporter({
      url: '/api/telemetry/otel/v1/traces',
    });
    provider = new WebTracerProvider({
      resource,
      sampler: new ParentBasedSampler({
        root: new TraceIdRatioBasedSampler(
          envClient.VITE_OTEL_TRACES_SAMPLE_RATE
        ),
      }),
      spanProcessors: [new BatchSpanProcessor(traceExporter)],
    });
    meterProvider = new MeterProvider({
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: '/api/telemetry/otel/v1/metrics',
          }),
          exportIntervalMillis: 30_000,
        }),
      ],
      resource,
    });
    const candidateAdapter = createOpenTelemetryAdapter({
      forceFlush: async () => {
        await Promise.all([
          provider!.forceFlush(),
          meterProvider!.forceFlush(),
        ]);
      },
    });
    const propagator = new CompositePropagator({
      propagators: [
        new W3CTraceContextPropagator(),
        new W3CBaggagePropagator(),
      ],
    });
    contextManager = new ZoneContextManager().enable();
    const ownedContextManager = contextManager;
    const ownedMeterProvider = meterProvider;
    const ownedTraceProvider = provider;

    claimTelemetryProviderOwnership([
      {
        acquire: () => context.setGlobalContextManager(ownedContextManager),
        name: 'context',
        release: () => context.disable(),
      },
      {
        acquire: () => propagation.setGlobalPropagator(propagator),
        name: 'propagation',
        release: () => propagation.disable(),
      },
      {
        acquire: () => metrics.setGlobalMeterProvider(ownedMeterProvider),
        name: 'metrics',
        release: () => metrics.disable(),
      },
      {
        acquire: () => trace.setGlobalTracerProvider(ownedTraceProvider),
        name: 'trace',
        release: () => trace.disable(),
      },
    ]);

    adapter = candidateAdapter;
    return adapter;
  } catch (failure) {
    contextManager?.disable();
    const cleanups: Array<() => Promise<unknown>> = [];
    if (provider) cleanups.push(provider.shutdown.bind(provider));
    if (meterProvider) {
      cleanups.push(meterProvider.shutdown.bind(meterProvider));
    }
    void cleanupTelemetryProviders('otel.client.cleanup', cleanups);
    throw failure;
  }
};
