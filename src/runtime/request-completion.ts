import {
  forceFlushTelemetry,
  type TelemetryAdapter,
  type TelemetryFlushOutcome,
} from '@/platform/telemetry';

const requestCompletions = new WeakMap<Request, Set<Promise<unknown>>>();

export const registerRequestCompletion = (
  request: Request,
  completion: Promise<unknown>
) => {
  const completions = requestCompletions.get(request) ?? new Set();
  completions.add(completion);
  requestCompletions.set(request, completions);
};

export const takeRequestCompletions = (request: Request) => {
  const completions = snapshotRequestCompletions(request);
  requestCompletions.delete(request);
  return completions;
};

export const snapshotRequestCompletions = (request: Request) => [
  ...(requestCompletions.get(request) ?? []),
];

export const forceFlushRequestTelemetry = (
  request: Request,
  telemetry: TelemetryAdapter,
  timeoutMs?: number
): Promise<TelemetryFlushOutcome> => {
  const completions = takeRequestCompletions(request);
  return forceFlushTelemetry(telemetry, timeoutMs, {
    beforeFlush: async (signal) => {
      if (signal.aborted) return;
      await Promise.allSettled(completions);
    },
  });
};
