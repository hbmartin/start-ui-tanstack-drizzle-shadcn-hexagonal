import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTelemetryAdapterChain } from '@/composition/telemetry/adapter-chain';
import { createNoOpTelemetry } from '@/platform/telemetry';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createTelemetryAdapterChain', () => {
  it('continues report-only fan-out when an earlier adapter throws', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const later = {
      ...createNoOpTelemetry(),
      captureException: vi.fn(),
      emitLog: vi.fn(),
      recordMetric: vi.fn(),
      setUser: vi.fn(),
    };
    const failing = {
      ...createNoOpTelemetry(),
      captureException: vi.fn(() => {
        throw new Error('capture failed');
      }),
      emitLog: vi.fn(() => {
        throw new Error('log failed');
      }),
      recordMetric: vi.fn(() => {
        throw new Error('metric failed');
      }),
      setUser: vi.fn(() => {
        throw new Error('user failed');
      }),
    };
    const chain = createTelemetryAdapterChain([failing, later]);

    expect(() =>
      chain.captureException(new Error('application failed'))
    ).not.toThrow();
    expect(() =>
      chain.emitLog({ event: 'app.failed', level: 'error' })
    ).not.toThrow();
    expect(() =>
      chain.recordMetric({ name: 'app.request', value: 1 })
    ).not.toThrow();
    expect(() => chain.setUser({ id: 'user-1' })).not.toThrow();

    expect(later.captureException).toHaveBeenCalledOnce();
    expect(later.emitLog).toHaveBeenCalledOnce();
    expect(later.recordMetric).toHaveBeenCalledOnce();
    expect(later.setUser).toHaveBeenCalledOnce();
  });

  it('flushes every adapter even when one rejects', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const laterFlush = vi.fn(() => Promise.resolve());
    const chain = createTelemetryAdapterChain([
      {
        ...createNoOpTelemetry(),
        forceFlush: vi.fn(() => Promise.reject(new Error('flush failed'))),
      },
      { ...createNoOpTelemetry(), forceFlush: laterFlush },
    ]);

    await expect(chain.forceFlush()).rejects.toThrow(
      'One or more telemetry adapters failed to flush'
    );
    expect(laterFlush).toHaveBeenCalledOnce();
  });
});
