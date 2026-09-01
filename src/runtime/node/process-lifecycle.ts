import {
  forceFlushTelemetry,
  reportTelemetryFailure,
  type TelemetryAdapter,
} from '@/platform/telemetry';

export type PersistentTelemetryRuntime = {
  shutdown(): Promise<void>;
};

type Signal = 'SIGINT' | 'SIGTERM';

export const createPersistentTelemetryRuntime = ({
  telemetry,
  shutdownProviders,
}: {
  telemetry?: TelemetryAdapter;
  shutdownProviders?: () => Promise<void>;
}): PersistentTelemetryRuntime | undefined => {
  if (!telemetry && !shutdownProviders) return undefined;

  return {
    shutdown: async () => {
      if (telemetry) await forceFlushTelemetry(telemetry);
      await shutdownProviders?.();
    },
  };
};

type ProcessLifecycle = {
  readonly pid: number;
  kill(pid: number, signal: Signal): boolean;
  off(event: 'beforeExit' | Signal, listener: (...args: never[]) => void): void;
  once(
    event: 'beforeExit' | Signal,
    listener: (...args: never[]) => void
  ): void;
};

export const installPersistentTelemetryLifecycle = (
  runtime: PersistentTelemetryRuntime,
  processLifecycle: ProcessLifecycle = process as unknown as ProcessLifecycle
) => {
  let shutdownPromise: Promise<void> | undefined;
  let terminating = false;

  const shutdown = () => {
    shutdownPromise ??= runtime.shutdown().catch((failure: unknown) => {
      reportTelemetryFailure('otel.node.shutdown', failure);
    });
    return shutdownPromise;
  };

  const beforeExit = () => {
    void shutdown();
  };
  const signalHandlers = new Map<Signal, () => void>();
  const removeListeners = () => {
    processLifecycle.off('beforeExit', beforeExit);
    for (const [signal, handler] of signalHandlers) {
      processLifecycle.off(signal, handler);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    const handler = () => {
      if (terminating) return;
      terminating = true;
      removeListeners();
      void shutdown().finally(() => {
        try {
          processLifecycle.kill(processLifecycle.pid, signal);
        } catch (failure) {
          reportTelemetryFailure('otel.node.signal', failure);
        }
      });
    };
    signalHandlers.set(signal, handler);
    processLifecycle.once(signal, handler);
  }
  processLifecycle.once('beforeExit', beforeExit);

  return removeListeners;
};
