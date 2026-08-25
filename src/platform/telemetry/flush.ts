import { reportTelemetryFailure } from './report-failure';
import type { TelemetryAdapter } from './types';

export type TelemetryFlushOutcome = 'failed' | 'flushed' | 'timed_out';
export type TelemetryFlushOptions = {
  beforeFlush?: (signal: AbortSignal) => Promise<void>;
};

const DEFAULT_FLUSH_TIMEOUT_MS = 5_000;

export const forceFlushTelemetry = async (
  telemetry: TelemetryAdapter,
  timeoutMs = DEFAULT_FLUSH_TIMEOUT_MS,
  options: TelemetryFlushOptions = {}
): Promise<TelemetryFlushOutcome> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const deadline = new AbortController();

  const timedOut = new Promise<TelemetryFlushOutcome>((resolve) => {
    timeout = setTimeout(() => {
      deadline.abort();
      resolve('timed_out');
    }, timeoutMs);
  });
  const flushed = Promise.resolve()
    .then(async () => {
      await options.beforeFlush?.(deadline.signal);
      if (deadline.signal.aborted) return 'timed_out' as const;
      await telemetry.forceFlush();
      return 'flushed' as const;
    })
    .catch((failure: unknown) => {
      reportTelemetryFailure('telemetry.force_flush', failure);
      return 'failed' as const;
    });

  const outcome = await Promise.race([flushed, timedOut]);
  if (timeout !== undefined) clearTimeout(timeout);
  if (outcome === 'timed_out') {
    reportTelemetryFailure(
      'telemetry.force_flush_timeout',
      new Error('timeout')
    );
  }

  return outcome;
};
