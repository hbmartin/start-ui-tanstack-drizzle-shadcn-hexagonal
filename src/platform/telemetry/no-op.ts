import type { TelemetryAdapter } from './types';

/**
 * No-op telemetry adapter used when no DSN is configured and in tests. Keeps
 * call sites unconditional so route loaders and server functions never need to
 * null-check the telemetry slot.
 */
const noOpAdapters = new WeakSet<TelemetryAdapter>();

export const createNoOpTelemetry = (): TelemetryAdapter => {
  const adapter: TelemetryAdapter = {
    captureException: () => {},
    setUser: () => {},
    startSpan: (_options, fn) => fn(),
    startManualSpan: () => ({
      addEvent: () => {},
      end: () => {},
      setAttributes: () => {},
      setStatus: () => {},
    }),
    currentCorrelation: () => ({}),
    emitLog: () => {},
    forceFlush: () => Promise.resolve(),
    recordMetric: () => {},
  };
  noOpAdapters.add(adapter);
  return adapter;
};

export const isNoOpTelemetry = (adapter: TelemetryAdapter) =>
  noOpAdapters.has(adapter);
