import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  registerRequestCompletion,
  takeRequestCompletions,
} from '@/runtime/request-completion';
import { runWithCloudflareSentry } from '@/runtime/cloudflare/sentry-request';

beforeEach(() => {
  vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
});

const requestOptions = {
  options: {},
  request: new Request('https://app.example.test'),
} as never;

describe('Cloudflare Sentry request isolation', () => {
  it('returns the exact application response and body stream', async () => {
    const request = new Request('https://app.example.test');
    const body = new ReadableStream();
    const applicationResponse = new Response(body);
    const api = {
      wrapRequestHandler: vi.fn(async (_options, handler) => {
        const sentinel = await handler();
        return new Response(sentinel.body, sentinel);
      }),
    };

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
    const api = {
      wrapRequestHandler: vi.fn(async () => {
        throw new Error('provider unavailable');
      }),
    };

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
    const api = {
      wrapRequestHandler: vi.fn(async (_options, handler) => handler()),
    };

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
    const api = {
      wrapRequestHandler: vi.fn(async (_options, handler) => {
        await handler();
        return handler();
      }),
    };

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

  it('keeps the request client alive until deferred stream work settles', async () => {
    const request = new Request('https://app.example.test');
    let resolveStream: (() => void) | undefined;
    const streamReady = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
    registerRequestCompletion(request, streamReady);
    let disposed = false;
    const captureLateStreamFailure = vi.fn((_failure: unknown) => undefined);
    const api = {
      wrapRequestHandler: vi.fn(async (_options, handler) => {
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
      }),
    };

    await runWithCloudflareSentry({
      api: api as never,
      handle: async () => new Response(new ReadableStream()),
      request,
      requestOptions,
    });

    captureLateStreamFailure(new Error('late stream failure'));
    expect(disposed).toBe(false);
    resolveStream?.();
    await Promise.allSettled(takeRequestCompletions(request));
    expect(disposed).toBe(true);
    expect(captureLateStreamFailure).toHaveBeenCalledOnce();
  });
});
