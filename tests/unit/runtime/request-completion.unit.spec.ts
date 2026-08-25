import { describe, expect, it, vi } from 'vitest';

import {
  forceFlushRequestTelemetry,
  registerRequestCompletion,
  takeRequestCompletions,
} from '@/runtime/request-completion';
import { createNoOpTelemetry } from '@/platform/telemetry';

describe('request completion registry', () => {
  it('bounds a never-settling stream completion and skips exporter work', async () => {
    vi.useFakeTimers();
    const request = new Request('https://app.example.test');
    let resolveCompletion: (() => void) | undefined;
    registerRequestCompletion(
      request,
      new Promise<void>((resolve) => {
        resolveCompletion = resolve;
      })
    );
    const forceFlush = vi.fn(() => Promise.resolve());

    const completion = forceFlushRequestTelemetry(
      request,
      { ...createNoOpTelemetry(), forceFlush },
      25
    );
    await vi.advanceTimersByTimeAsync(25);

    await expect(completion).resolves.toBe('timed_out');
    expect(forceFlush).not.toHaveBeenCalled();
    resolveCompletion?.();
    await vi.runAllTimersAsync();
    await Promise.resolve();
    expect(forceFlush).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('returns every completion once and releases the request key', () => {
    const request = new Request('https://app.example/');
    const first = Promise.resolve('first');
    const second = Promise.resolve('second');

    registerRequestCompletion(request, first);
    registerRequestCompletion(request, second);

    expect(takeRequestCompletions(request)).toEqual([first, second]);
    expect(takeRequestCompletions(request)).toEqual([]);
  });
});
