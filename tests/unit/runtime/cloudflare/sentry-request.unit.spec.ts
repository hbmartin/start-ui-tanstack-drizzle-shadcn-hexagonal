import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerRequestCompletion,
  takeRequestCompletions,
} from '@/runtime/request-completion';
import {
  initializeCloudflareSentryApplication,
  initializeCloudflareSentryIsolation,
  runWithCloudflareSentry,
} from '@/runtime/cloudflare/sentry-request';

beforeEach(() => {
  vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
});

const requestOptions = {
  context: {
    waitUntil() {},
  } as never,
  options: {},
  request: new Request('https://app.example.test'),
};

const requestApi = (wrapRequestHandler: (...args: never[]) => unknown) => ({
  withScope: <T>(callback: () => T) => callback(),
  wrapRequestHandler,
});

describe('Cloudflare Sentry request isolation', () => {
  it('installs request isolation before loading the application', async () => {
    const calls: string[] = [];
    const api = {
      setAsyncLocalStorageAsyncContextStrategy: vi.fn(() => {
        calls.push('isolation');
      }),
    };

    const initialized = await initializeCloudflareSentryApplication(
      api as never,
      async () => {
        calls.push('application');
        return { fetch: vi.fn() };
      }
    );

    expect(calls).toEqual(['isolation', 'application']);
    expect(api.setAsyncLocalStorageAsyncContextStrategy).toHaveBeenCalledOnce();
    expect(initialized).toEqual({
      application: expect.objectContaining({ fetch: expect.any(Function) }),
      sentryRequestIsolationReady: true,
    });
  });

  it.each(['HEAD', 'OPTIONS'])(
    'uses a body-capable lifecycle request for %s without changing the application request',
    async (method) => {
      const request = new Request('https://app.example.test/resource', {
        method,
      });
      const applicationResponse = new Response(null, { status: 204 });
      const handle = vi.fn(async () => applicationResponse);
      const api = requestApi(
        vi.fn(async (_options, handler) => handler()) as never
      );

      await expect(
        runWithCloudflareSentry({
          api: api as never,
          handle,
          request,
          requestOptions: { ...requestOptions, request } as never,
        })
      ).resolves.toBe(applicationResponse);

      expect(handle).toHaveBeenCalledOnce();
      const wrappedRequest = (
        vi.mocked(api.wrapRequestHandler).mock.calls[0]?.[0] as
          | { request: Request }
          | undefined
      )?.request;
      expect(wrappedRequest).toBeInstanceOf(Request);
      expect(wrappedRequest).not.toBe(request);
      expect(wrappedRequest?.method).toBe('GET');
      expect(wrappedRequest?.url).toBe(request.url);
      expect(request.method).toBe(method);
    }
  );

  it('disables Sentry safely when async-context installation fails', () => {
    const report = vi.spyOn(globalThis.console, 'error');
    const failure = new Error('async context unavailable');
    const api = {
      setAsyncLocalStorageAsyncContextStrategy: vi.fn(() => {
        throw failure;
      }),
    };

    expect(initializeCloudflareSentryIsolation(api as never)).toBe(false);
    expect(api.setAsyncLocalStorageAsyncContextStrategy).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledWith('telemetry.report_failure', {
      errorType: 'Error',
      source: 'sentry.cloudflare.async_context',
    });
  });

  it('returns the exact application response and body stream', async () => {
    const request = new Request('https://app.example.test');
    const body = new ReadableStream();
    const applicationResponse = new Response(body);
    const api = requestApi(
      vi.fn(async (_options, handler) => {
        const sentinel = await handler();
        return new Response(sentinel.body, sentinel);
      }) as never
    );

    const returned = await runWithCloudflareSentry({
      api: api as never,
      handle: async () => applicationResponse,
      request,
      requestOptions,
    });

    expect(returned).toBe(applicationResponse);
    expect(returned.body).toBe(body);
  });

  it('runs the application once when Sentry setup fails', async () => {
    const request = new Request('https://app.example.test');
    const applicationResponse = new Response('available');
    const handle = vi.fn(async () => applicationResponse);
    const api = requestApi(
      vi.fn(async () => {
        throw new Error('provider unavailable');
      }) as never
    );

    await expect(
      runWithCloudflareSentry({
        api: api as never,
        handle,
        request,
        requestOptions,
      })
    ).resolves.toBe(applicationResponse);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('rethrows the exact application failure without retrying', async () => {
    const request = new Request('https://app.example.test');
    const applicationFailure = new Error('application failed');
    const handle = vi.fn(async () => {
      throw applicationFailure;
    });
    const api = requestApi(
      vi.fn(async (_options, handler) => handler()) as never
    );

    await expect(
      runWithCloudflareSentry({
        api: api as never,
        handle,
        request,
        requestOptions,
      })
    ).rejects.toBe(applicationFailure);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('memoizes application work when a provider invokes its callback twice', async () => {
    const request = new Request('https://app.example.test');
    const applicationResponse = new Response('available');
    const handle = vi.fn(async () => applicationResponse);
    const api = requestApi(
      vi.fn(async (_options, handler) => {
        await handler();
        return handler();
      }) as never
    );

    await expect(
      runWithCloudflareSentry({
        api: api as never,
        handle,
        request,
        requestOptions,
      })
    ).resolves.toBe(applicationResponse);
    expect(handle).toHaveBeenCalledOnce();
  });

  it('keeps the wrapped sentinel alive until deferred stream work settles', async () => {
    const request = new Request('https://app.example.test');
    let resolveStream: (() => void) | undefined;
    const streamReady = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
    registerRequestCompletion(request, streamReady);
    let disposed = false;
    const api = requestApi(
      vi.fn(async (_options, handler) => {
        const sentinel = await handler();
        const transform = new TransformStream({
          flush() {
            disposed = true;
          },
        });
        return new Response(sentinel.body?.pipeThrough(transform), {
          headers: sentinel.headers,
          status: sentinel.status,
        });
      }) as never
    );

    await runWithCloudflareSentry({
      api: api as never,
      handle: async () => new Response(new ReadableStream()),
      request,
      requestOptions,
    });

    expect(disposed).toBe(false);
    resolveStream?.();
    await Promise.allSettled(takeRequestCompletions(request));
    expect(disposed).toBe(true);
  });
});
