import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNoOpTelemetry,
  forceFlushTelemetry,
  setTelemetry,
  telemetryProxy,
} from '@/platform/telemetry';

afterEach(() => {
  setTelemetry(createNoOpTelemetry());
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('forceFlushTelemetry', () => {
  it('reports successful and rejected flushes as bounded outcomes', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);

    await expect(forceFlushTelemetry(createNoOpTelemetry(), 10)).resolves.toBe(
      'flushed'
    );
    await expect(
      forceFlushTelemetry(
        {
          ...createNoOpTelemetry(),
          forceFlush: () => Promise.reject(new Error('export failed')),
        },
        10
      )
    ).resolves.toBe('failed');
  });

  it('returns after the timeout when an exporter never settles', async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const outcome = forceFlushTelemetry(
      {
        ...createNoOpTelemetry(),
        forceFlush: () => new Promise<void>(() => {}),
      },
      25
    );

    await vi.advanceTimersByTimeAsync(25);

    await expect(outcome).resolves.toBe('timed_out');
  });

  it('classifies a rejecting active adapter through the public proxy', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    setTelemetry({
      ...createNoOpTelemetry(),
      forceFlush: () => Promise.reject(new Error('export failed')),
    });

    await expect(forceFlushTelemetry(telemetryProxy, 10)).resolves.toBe(
      'failed'
    );
  });
});
