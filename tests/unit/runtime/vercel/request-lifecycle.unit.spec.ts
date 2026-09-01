import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapterForceFlush: vi.fn(() => Promise.resolve()),
  forceFlushTelemetry: vi.fn(async (telemetry, _timeout, options) => {
    await options?.beforeFlush?.(new AbortController().signal);
    await telemetry.forceFlush();
    return 'flushed';
  }),
  getTelemetry: vi.fn(() => ({ forceFlush: mocks.adapterForceFlush })),
  waitUntil: vi.fn(),
}));

vi.mock('@vercel/functions', () => ({ waitUntil: mocks.waitUntil }));
vi.mock('@/platform/telemetry', () => ({
  forceFlushTelemetry: mocks.forceFlushTelemetry,
  getTelemetry: mocks.getTelemetry,
  reportTelemetryFailure: vi.fn(),
}));

import { registerRequestCompletion } from '@/runtime/request-completion';
import { vercelRequestLifecycle } from '@/runtime/vercel/request-lifecycle';

describe('Vercel request telemetry lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('uses waitUntil and flushes only after the response stream is ready', async () => {
    let resolveStream: (() => void) | undefined;
    const streamReady = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
    const request = new Request('https://app.example/');
    registerRequestCompletion(request, streamReady);

    vercelRequestLifecycle.onRequestSettled(request);

    expect(mocks.waitUntil).toHaveBeenCalledOnce();
    expect(mocks.forceFlushTelemetry).toHaveBeenCalledOnce();
    expect(mocks.adapterForceFlush).not.toHaveBeenCalled();
    resolveStream?.();
    await mocks.waitUntil.mock.calls[0]?.[0];
    expect(mocks.getTelemetry).toHaveBeenCalledOnce();
    expect(mocks.adapterForceFlush).toHaveBeenCalledOnce();
  });
});
