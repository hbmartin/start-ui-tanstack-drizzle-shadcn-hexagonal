import { beforeEach, describe, expect, it, vi } from 'vitest';

import { runtimeProfiles } from '@/platform/runtime/runtime-profile';
import type { RuntimeRequestScope } from '@/runtime/create-application-server-entry';

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

  it('reports a synchronous request-scope setup failure and still serves the request', async () => {
    const scopeFailure = new Error('request scope failed');
    const scopeEntered = vi.fn();
    const requestScope: RuntimeRequestScope = <T>(_operation: () => T): T => {
      scopeEntered();
      throw scopeFailure;
    };
    const { createApplicationServerEntry } =
      await import('@/runtime/create-application-server-entry');
    const entry = await createApplicationServerEntry(
      'node',
      undefined,
      requestScope
    );

    const response = await entry.fetch(new Request('https://app.example/'), {
      context: undefined as never,
    });

    expect(await response.text()).toBe('ok');
    expect(scopeEntered).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'sentry.request_scope',
      scopeFailure
    );
  });

  it('does not run the application twice when the request scope throws after invoking it', async () => {
    const scopeFailure = new Error('request scope teardown failed');
    const scopeEntered = vi.fn();
    const requestScope: RuntimeRequestScope = <T>(operation: () => T): T => {
      scopeEntered();
      operation();
      throw scopeFailure;
    };
    const { createApplicationServerEntry } =
      await import('@/runtime/create-application-server-entry');
    const entry = await createApplicationServerEntry(
      'node',
      undefined,
      requestScope
    );

    const response = await entry.fetch(new Request('https://app.example/'), {
      context: undefined as never,
    });

    expect(await response.text()).toBe('ok');
    expect(scopeEntered).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledOnce();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'sentry.request_scope',
      scopeFailure
    );
  });

  it('preserves an application rejection when the request scope throws after invocation', async () => {
    const applicationFailure = new Error('application failed');
    const scopeFailure = new Error('request scope teardown failed');
    mocks.fetch.mockRejectedValueOnce(applicationFailure);
    const scopeEntered = vi.fn();
    const requestScope: RuntimeRequestScope = <T>(operation: () => T): T => {
      scopeEntered();
      operation();
      throw scopeFailure;
    };
    const { createApplicationServerEntry } =
      await import('@/runtime/create-application-server-entry');
    const entry = await createApplicationServerEntry(
      'node',
      undefined,
      requestScope
    );

    await expect(
      entry.fetch(new Request('https://app.example/'), {
        context: undefined as never,
      })
    ).rejects.toBe(applicationFailure);
    expect(scopeEntered).toHaveBeenCalledOnce();
    expect(mocks.fetch).toHaveBeenCalledOnce();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledOnce();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'sentry.request_scope',
      scopeFailure
    );
  });
});
