import { describe, expect, it, vi } from 'vitest';

import { createNoOpTelemetry } from '@/platform/telemetry';
import {
  createPersistentTelemetryRuntime,
  installPersistentTelemetryLifecycle,
} from '@/runtime/node/process-lifecycle';

type LifecycleEvent = 'beforeExit' | 'SIGINT' | 'SIGTERM';

const createProcessLifecycle = () => {
  const listeners = new Map<LifecycleEvent, () => void>();
  const lifecycle = {
    kill: vi.fn(() => true),
    off: vi.fn((event: LifecycleEvent) => listeners.delete(event)),
    once: vi.fn((event: LifecycleEvent, listener: () => void) => {
      listeners.set(event, listener);
    }),
    pid: 42,
  };
  return { lifecycle, listeners };
};

describe('persistent Node telemetry lifecycle', () => {
  it('flushes a Sentry-only adapter during shutdown', async () => {
    const forceFlush = vi.fn(() => Promise.resolve());
    const runtime = createPersistentTelemetryRuntime({
      telemetry: { ...createNoOpTelemetry(), forceFlush },
    });

    await runtime?.shutdown();

    expect(forceFlush).toHaveBeenCalledOnce();
  });

  it('flushes the installed chain before shutting down OTel providers', async () => {
    const order: string[] = [];
    const runtime = createPersistentTelemetryRuntime({
      telemetry: {
        ...createNoOpTelemetry(),
        forceFlush: async () => {
          order.push('chain');
        },
      },
      shutdownProviders: async () => {
        order.push('providers');
      },
    });

    await runtime?.shutdown();

    expect(order).toEqual(['chain', 'providers']);
  });

  it('flushes once during beforeExit', async () => {
    const shutdown = vi.fn(() => Promise.resolve());
    const { lifecycle, listeners } = createProcessLifecycle();
    installPersistentTelemetryLifecycle({ shutdown }, lifecycle as never);

    listeners.get('beforeExit')?.();
    await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce());
    listeners.get('beforeExit')?.();
    expect(shutdown).toHaveBeenCalledOnce();
  });

  it('shuts down before re-raising the original signal', async () => {
    let resolveShutdown: (() => void) | undefined;
    const shutdown = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveShutdown = resolve;
        })
    );
    const { lifecycle, listeners } = createProcessLifecycle();
    installPersistentTelemetryLifecycle({ shutdown }, lifecycle as never);

    listeners.get('SIGTERM')?.();
    expect(shutdown).toHaveBeenCalledOnce();
    expect(lifecycle.kill).not.toHaveBeenCalled();

    resolveShutdown?.();
    await vi.waitFor(() =>
      expect(lifecycle.kill).toHaveBeenCalledWith(42, 'SIGTERM')
    );
  });
});
