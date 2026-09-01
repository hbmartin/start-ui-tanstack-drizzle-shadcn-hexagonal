import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  adapterForceFlush: vi.fn(() => Promise.resolve()),
  forceFlushTelemetry: vi.fn(async (telemetry, _timeout, options) => {
    await options?.beforeFlush?.(new AbortController().signal);
    await telemetry.forceFlush();
    return 'flushed';
  }),
}));

vi.mock('@/platform/telemetry', () => ({
  forceFlushTelemetry: mocks.forceFlushTelemetry,
  reportTelemetryFailure: vi.fn(),
}));

import { registerRequestCompletion } from '@/runtime/request-completion';
import { scheduleCloudflareRequestFlush } from '@/runtime/cloudflare/request-lifecycle';

describe('Cloudflare request telemetry lifecycle', () => {
  it('extends the execution context until stream completion and flush', async () => {
    const request = new Request('https://app.example/');
    registerRequestCompletion(request, Promise.resolve());
    const waitUntil = vi.fn();
    const requestTelemetry = { forceFlush: mocks.adapterForceFlush };

    scheduleCloudflareRequestFlush(
      request,
      requestTelemetry as never,
      waitUntil
    );

    expect(waitUntil).toHaveBeenCalledOnce();
    await waitUntil.mock.calls[0]?.[0];
    expect(mocks.forceFlushTelemetry).toHaveBeenCalledOnce();
    expect(mocks.forceFlushTelemetry).toHaveBeenCalledWith(
      requestTelemetry,
      undefined,
      expect.any(Object)
    );
    expect(mocks.adapterForceFlush).toHaveBeenCalledOnce();
  });
});
