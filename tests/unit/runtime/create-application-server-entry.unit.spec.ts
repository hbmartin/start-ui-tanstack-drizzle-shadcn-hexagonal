import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runtimeProfiles } from '@/platform/runtime/runtime-profile';

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(async () => new Response('ok')),
  reportTelemetryFailure: vi.fn(),
}));

vi.mock('@/entry-server', () => ({
  createServerEntry: (entry: unknown) => entry,
  default: { fetch: mocks.fetch },
}));

vi.mock('@/platform/telemetry', () => ({
  bindRequestExceptionState: vi.fn(),
  claimRequestException: vi.fn(() => true),
  createRequestExceptionCaptureState: vi.fn(() => ({
    captured: new Set(),
  })),
  reportTelemetryFailure: mocks.reportTelemetryFailure,
  telemetryProxy: { captureException: vi.fn() },
}));

describe('application server entry runtime profile', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.fetch.mockResolvedValue(new Response('ok'));
  });

  it.each(runtimeProfiles)(
    'injects the trusted %s profile into every request context',
    async (runtimeProfile) => {
      const { createApplicationServerEntry } =
        await import('@/runtime/create-application-server-entry');
      const entry = await createApplicationServerEntry(runtimeProfile);
      const request = new Request('https://app.example/');

      await entry.fetch(request, { context: undefined as never });

      expect(mocks.fetch).toHaveBeenCalledWith(
        request,
        expect.objectContaining({
          context: expect.objectContaining({ runtimeProfile }),
        })
      );
    }
  );

  it('does not classify an asynchronous application rejection as a request-scope setup failure', async () => {
    const failure = new Error('application failed');
    mocks.fetch.mockRejectedValueOnce(failure);
    const { createApplicationServerEntry } =
      await import('@/runtime/create-application-server-entry');
    const entry = await createApplicationServerEntry(
      'node',
      undefined,
      (operation) => operation()
    );

    await expect(
      entry.fetch(new Request('https://app.example/'), {
        context: undefined as never,
      })
    ).rejects.toBe(failure);
    expect(mocks.reportTelemetryFailure).not.toHaveBeenCalledWith(
      'sentry.request_scope',
      expect.anything()
    );
  });
});
