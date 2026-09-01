import { createNoOpTelemetry, isNoOpTelemetry } from './no-op';
import { reportTelemetryFailure } from './report-failure';
import type { TelemetryAdapter } from './types';

let activeAdapter: TelemetryAdapter = createNoOpTelemetry();
type TelemetryScopeResolver = () => TelemetryAdapter | undefined;
let telemetryScopeResolver: TelemetryScopeResolver | undefined;

export const setTelemetry = (adapter: TelemetryAdapter) => {
  activeAdapter = adapter;
};

export const installTelemetryScopeResolver = (
  resolver: TelemetryScopeResolver
): void => {
  if (telemetryScopeResolver && telemetryScopeResolver !== resolver) {
    throw new Error('Telemetry scope resolver is already installed');
  }
  telemetryScopeResolver = resolver;
};

const resolveTelemetry = (): TelemetryAdapter => {
  if (!telemetryScopeResolver) return activeAdapter;
  try {
    return telemetryScopeResolver() ?? activeAdapter;
  } catch (failure) {
    reportTelemetryFailure('telemetry.resolve_scope', failure);
    return activeAdapter;
  }
};

export const getTelemetry = (): TelemetryAdapter => resolveTelemetry();

export const isTelemetryAvailable = () => !isNoOpTelemetry(resolveTelemetry());

const noOpManualSpan = createNoOpTelemetry().startManualSpan({
  name: 'telemetry.noop',
});

const reportOnly = (source: string, action: () => void): void => {
  try {
    action();
  } catch (failure) {
    reportTelemetryFailure(source, failure);
  }
};

const isPromiseLike = <T>(value: T): value is T & Promise<Awaited<T>> => {
  try {
    return (
      value !== null &&
      value !== undefined &&
      (typeof value === 'object' || typeof value === 'function') &&
      'then' in value &&
      typeof (value as { then?: unknown }).then === 'function'
    );
  } catch (failure) {
    reportTelemetryFailure('telemetry.inspect_thenable', failure);
    return false;
  }
};

const startSpanSafely = <T>(
  options: Parameters<TelemetryAdapter['startSpan']>[0],
  work: () => T
): T => {
  type WorkState = 'not_started' | 'running' | 'returned' | 'threw';
  let workState: WorkState = 'not_started';
  const getWorkState = (): WorkState => workState;
  let workResult: T | undefined;
  let workFailure: unknown;

  const runWorkOnce = (): T => {
    if (workState === 'returned') return workResult as T;
    if (workState === 'threw') throw workFailure;
    if (workState === 'running') {
      throw new Error('Telemetry adapter invoked traced work recursively');
    }

    workState = 'running';
    try {
      workResult = work();
      workState = 'returned';
      return workResult;
    } catch (failure) {
      workFailure = failure;
      workState = 'threw';
      throw failure;
    }
  };

  let providerResult: unknown;
  try {
    providerResult = resolveTelemetry().startSpan(options, runWorkOnce);
  } catch (providerFailure) {
    if (getWorkState() !== 'threw' || providerFailure !== workFailure) {
      reportTelemetryFailure('telemetry.start_span', providerFailure);
    }
  }

  if (workState === 'not_started') {
    reportTelemetryFailure(
      'telemetry.start_span',
      new Error('Telemetry adapter skipped traced work')
    );
    try {
      runWorkOnce();
    } catch {
      // The memoized application failure is rethrown below.
    }
  }

  if (isPromiseLike(providerResult) && providerResult !== workResult) {
    void Promise.resolve(providerResult).catch(
      async (providerFailure: unknown) => {
        if (isPromiseLike(workResult)) {
          try {
            await workResult;
          } catch (applicationFailure) {
            if (providerFailure === applicationFailure) return;
          }
        }
        reportTelemetryFailure('telemetry.start_span', providerFailure);
      }
    );
  }

  if (getWorkState() === 'threw') throw workFailure;
  return workResult as T;
};

const guardManualSpan = (
  span: ReturnType<TelemetryAdapter['startManualSpan']>
): ReturnType<TelemetryAdapter['startManualSpan']> => ({
  addEvent: (name, attributes) => {
    reportOnly('telemetry.manual_span.add_event', () => {
      if (attributes === undefined) {
        span.addEvent(name);
        return;
      }
      span.addEvent(name, attributes);
    });
  },
  end: () => {
    reportOnly('telemetry.manual_span.end', () => span.end());
  },
  setAttributes: (attributes) => {
    reportOnly('telemetry.manual_span.set_attributes', () =>
      span.setAttributes(attributes)
    );
  },
  setStatus: (status) => {
    reportOnly('telemetry.manual_span.set_status', () =>
      span.setStatus(status)
    );
  },
});

export const telemetryProxy: TelemetryAdapter = {
  captureException: (error, context) => {
    reportOnly('telemetry.capture_exception', () =>
      resolveTelemetry().captureException(error, context)
    );
  },
  setUser: (user) => {
    reportOnly('telemetry.set_user', () => resolveTelemetry().setUser(user));
  },
  startSpan: startSpanSafely,
  startManualSpan: (options) => {
    try {
      return guardManualSpan(resolveTelemetry().startManualSpan(options));
    } catch (failure) {
      reportTelemetryFailure('telemetry.start_manual_span', failure);
      return noOpManualSpan;
    }
  },
  currentCorrelation: () => {
    try {
      return resolveTelemetry().currentCorrelation();
    } catch (failure) {
      reportTelemetryFailure('telemetry.current_correlation', failure);
      return {};
    }
  },
  emitLog: (record) => {
    reportOnly('telemetry.emit_log', () => resolveTelemetry().emitLog(record));
  },
  forceFlush: async () => {
    try {
      await resolveTelemetry().forceFlush();
    } catch (failure) {
      reportTelemetryFailure('telemetry.force_flush', failure);
      throw failure;
    }
  },
  recordMetric: (input) => {
    reportOnly('telemetry.record_metric', () =>
      resolveTelemetry().recordMetric(input)
    );
  },
};
