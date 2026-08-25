import {
  reportTelemetryFailure,
  type TelemetryAdapter,
} from '@/platform/telemetry';

const fanOut = (
  adapters: readonly TelemetryAdapter[],
  source: string,
  action: (adapter: TelemetryAdapter) => void
): void => {
  for (const adapter of adapters) {
    try {
      action(adapter);
    } catch (failure) {
      reportTelemetryFailure(source, failure);
    }
  }
};

export const createTelemetryAdapterChain = (
  adapters: readonly TelemetryAdapter[]
): TelemetryAdapter => {
  const [primary] = adapters;

  if (!primary) {
    throw new Error('Telemetry adapter chain requires at least one adapter');
  }

  return {
    captureException: (error, context) => {
      fanOut(adapters, 'telemetry.chain.capture_exception', (adapter) =>
        adapter.captureException(error, context)
      );
    },
    currentCorrelation: () => primary.currentCorrelation(),
    emitLog: (record) => {
      fanOut(adapters, 'telemetry.chain.emit_log', (adapter) =>
        adapter.emitLog(record)
      );
    },
    forceFlush: async () => {
      const outcomes = await Promise.all(
        adapters.map(async (adapter) => {
          try {
            await adapter.forceFlush();
            return true;
          } catch (failure) {
            reportTelemetryFailure('telemetry.chain.force_flush', failure);
            return false;
          }
        })
      );
      if (outcomes.includes(false)) {
        throw new Error('One or more telemetry adapters failed to flush');
      }
    },
    recordMetric: (input) => {
      fanOut(adapters, 'telemetry.chain.record_metric', (adapter) =>
        adapter.recordMetric(input)
      );
    },
    setUser: (user) => {
      fanOut(adapters, 'telemetry.chain.set_user', (adapter) =>
        adapter.setUser(user)
      );
    },
    startManualSpan: (options) => primary.startManualSpan(options),
    startSpan: (options, fn) => primary.startSpan(options, fn),
  };
};
