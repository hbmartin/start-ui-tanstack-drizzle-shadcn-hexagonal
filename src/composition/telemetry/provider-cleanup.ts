import { reportTelemetryFailure } from '@/platform/telemetry';

const CLEANUP_TIMEOUT_MS = 5_000;

type ProviderCleanup = () => Promise<unknown>;

export const cleanupTelemetryProviders = async (
  source: string,
  cleanups: ProviderCleanup[],
  timeoutMs = CLEANUP_TIMEOUT_MS
): Promise<'cleaned' | 'failed' | 'timed_out'> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = Promise.allSettled(
    cleanups.map(async (runCleanup) => runCleanup())
  ).then((results) =>
    results.some((result) => result.status === 'rejected')
      ? ('failed' as const)
      : ('cleaned' as const)
  );
  const timeout = new Promise<'timed_out'>((resolve) => {
    timer = setTimeout(() => resolve('timed_out'), timeoutMs);
    timer.unref?.();
  });

  const outcome = await Promise.race([cleanup, timeout]);
  if (timer) clearTimeout(timer);
  if (outcome !== 'cleaned') {
    reportTelemetryFailure(source, new Error(`Telemetry cleanup ${outcome}`));
  }
  return outcome;
};
