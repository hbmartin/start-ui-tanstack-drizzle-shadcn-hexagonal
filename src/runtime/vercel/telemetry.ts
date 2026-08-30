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
  type SentryNodeRequestContext,
  type SentryNodeRequestContextManager,
} from '@/composition/telemetry/sentry-node-request-context';
import { installServerTelemetry } from '@/composition/telemetry/sentry.server';
import {
  assertRequiredTelemetrySignals,
  createTelemetrySignalReadiness,
  getTelemetryConfig,
  runWithNormalizedOtelSdkEnvironment,
  type TelemetryConfig,
} from '@/modules/kernel/backend';
import {
  isServerSentryInstrumentationReady,
  reportTelemetryFailure,
} from '@/platform/telemetry';

let initialized = false;
let initializationFailure: unknown;
let initializationFailed = false;

export const runWithVercelSentryRequestIsolation =
  runWithSentryNodeRequestIsolation;

const exporterHeaders = (bearerToken: string | undefined) =>
  bearerToken ? { Authorization: `Bearer ${bearerToken}` } : undefined;

const initializeTraceOwner = (
  config: TelemetryConfig,
  contextManager: SentryNodeRequestContextManager | undefined
): {
  fallbackRequestContext?: SentryNodeRequestContext;
  requestContextReady: boolean;
  traceOwnerReady: boolean;
} => {
  if (config.otelSdkDisabled) {
    const fallbackRequestContext = contextManager
      ? claimSentryNodeRequestContext(contextManager)
      : undefined;
    return {
      fallbackRequestContext,
      requestContextReady: Boolean(fallbackRequestContext),
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
    const fallbackRequestContext = contextManager
      ? claimSentryNodeRequestContext(contextManager, {
          acceptAlreadyInstalledByProvider: true,
        })
      : undefined;
    return {
      fallbackRequestContext,
      requestContextReady: Boolean(fallbackRequestContext),
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
  cleaned?: boolean;
  logger?: LoggerProvider;
  meter?: MeterProvider;
  ready: boolean;
  releaseOwnership?: () => void;
};

const cleanupSignalOwners = (owners: SignalOwners) => {
  if (owners.cleaned) return;
  owners.cleaned = true;
  owners.ready = false;
  const releaseOwnership = owners.releaseOwnership;
  const logger = owners.logger;
  const meter = owners.meter;
  owners.releaseOwnership = undefined;
  owners.logger = undefined;
  owners.meter = undefined;
  releaseOwnership?.();
  const cleanups = [logger, meter]
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
    owners.releaseOwnership = claimTelemetryProviderOwnership([
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
  if (initializationFailed) throw initializationFailure;

  try {
    const config = getTelemetryConfig();
    const contextManager = createSentryNodeRequestContextManager();
    const { fallbackRequestContext, requestContextReady, traceOwnerReady } =
      initializeTraceOwner(config, contextManager);
    let fallbackRequestContextReleased = false;
    const releaseFallbackRequestContext = () => {
      if (fallbackRequestContextReleased) return;
      fallbackRequestContextReleased = true;
      fallbackRequestContext?.release();
    };
    const signalOwners = config.otelSdkDisabled
      ? { logger: undefined, meter: undefined, ready: false }
      : initializeSignalOwners(config);

    let openTelemetry:
      | ReturnType<typeof createOpenTelemetryAdapter>
      | undefined;
    if (traceOwnerReady || signalOwners.ready) {
      try {
        openTelemetry = createOpenTelemetryAdapter({
          forceFlush: async () => {
            await Promise.all([
              signalOwners.logger?.forceFlush(),
              signalOwners.meter?.forceFlush(),
            ]);
          },
        });
      } catch (failure) {
        cleanupSignalOwners(signalOwners);
        reportTelemetryFailure('otel.vercel.adapter.initialize', failure);
      }
    }
    const sentryReady = Boolean(
      config.dsn && requestContextReady && isServerSentryInstrumentationReady()
    );
    if (!sentryReady) releaseFallbackRequestContext();
    try {
      assertRequiredTelemetrySignals({
        config,
        phase: 'initialization',
        profile: 'vercel',
        readiness: createTelemetrySignalReadiness({
          exceptions: sentryReady,
          logs: Boolean(openTelemetry && signalOwners.ready),
          metrics: Boolean(openTelemetry && signalOwners.ready),
          traces: Boolean(openTelemetry && traceOwnerReady),
        }),
      });
    } catch (failure) {
      cleanupSignalOwners(signalOwners);
      releaseFallbackRequestContext();
      throw failure;
    }
    try {
      installServerTelemetry({
        openTelemetry,
        sentry: sentryReady ? Sentry : undefined,
      });
    } catch (failure) {
      cleanupSignalOwners(signalOwners);
      releaseFallbackRequestContext();
      throw failure;
    }
    initialized = true;
  } catch (failure) {
    initializationFailure = failure;
    initializationFailed = true;
    throw failure;
  }
};
