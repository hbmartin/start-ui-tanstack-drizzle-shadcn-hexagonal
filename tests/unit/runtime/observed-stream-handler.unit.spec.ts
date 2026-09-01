import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNoOpTelemetry,
  setTelemetry,
  type TelemetryAdapter,
} from '@/platform/telemetry';

const renderer = vi.hoisted(() => ({
  renderToReadableStream: vi.fn(),
}));

vi.mock('react-dom/server', () => ({
  default: renderer,
}));

vi.mock('isbot', () => ({ isbot: () => false }));

vi.mock('@tanstack/react-start/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-start/server')>();
  return {
    ...actual,
    StartServer: () => null,
    defineHandlerCallback: (callback: unknown) => callback,
    transformReadableStreamWithRouter: (
      _router: unknown,
      stream: ReadableStream
    ) => stream,
  };
});

vi.mock('@tanstack/react-router/ssr/server', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@tanstack/react-router/ssr/server')>();
  return {
    ...actual,
    createSsrStreamResponse: (_router: unknown, response: Response) => ({
      response,
      serverSsrCleanup: 'stream',
    }),
  };
});

afterEach(() => {
  setTelemetry(createNoOpTelemetry());
  vi.clearAllMocks();
});

describe('observedStreamHandler', () => {
  it('captures a producer failure without replacing the response or body', async () => {
    const renderError = new Error('render stream failed');
    let sourceStream: ReadableStream<Uint8Array> | undefined;
    renderer.renderToReadableStream.mockImplementationOnce(
      async (_node, options: { onError: (error: unknown) => void }) => {
        sourceStream = new ReadableStream({
          pull(controller) {
            options.onError(renderError);
            controller.error(renderError);
          },
        });
        Object.assign(sourceStream, { allReady: Promise.resolve() });
        return sourceStream;
      }
    );
    const captureException = vi.fn();
    setTelemetry({
      ...createNoOpTelemetry(),
      captureException,
    } satisfies TelemetryAdapter);
    const { observedStreamHandler } =
      await import('@/runtime/observed-stream-handler');
    const result = await observedStreamHandler({
      request: new Request('https://app.example/'),
      responseHeaders: new Headers({ 'content-type': 'text/html' }),
      router: {
        options: {},
        stores: { statusCode: { get: () => 200 } },
      },
    } as never);

    expect(result).toMatchObject({ serverSsrCleanup: 'stream' });
    const response = (result as { response: Response }).response;
    expect(response.body).toBe(sourceStream);
    await expect(response.text()).rejects.toBe(renderError);
    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(renderError, {
      level: 'error',
      tags: { event: 'framework.stream.failed' },
    });
  });

  it('keeps hostile producer failures observable without replacing them', async () => {
    const hostileFailure = new Proxy(
      {},
      {
        getPrototypeOf() {
          throw new Error('hostile prototype');
        },
      }
    );
    let sourceStream: ReadableStream<Uint8Array> | undefined;
    renderer.renderToReadableStream.mockImplementationOnce(
      async (_node, options: { onError: (error: unknown) => void }) => {
        sourceStream = new ReadableStream({
          pull(controller) {
            expect(() => options.onError(hostileFailure)).not.toThrow();
            controller.error(hostileFailure);
          },
        });
        Object.assign(sourceStream, { allReady: Promise.resolve() });
        return sourceStream;
      }
    );
    const captureException = vi.fn();
    setTelemetry({
      ...createNoOpTelemetry(),
      captureException,
    } satisfies TelemetryAdapter);
    const { observedStreamHandler } =
      await import('@/runtime/observed-stream-handler');
    const result = await observedStreamHandler({
      request: new Request('https://app.example/'),
      responseHeaders: new Headers(),
      router: {
        options: {},
        stores: { statusCode: { get: () => 200 } },
      },
    } as never);

    const response = (result as { response: Response }).response;
    expect(response.body).toBe(sourceStream);
    let consumedFailure: unknown;
    try {
      await response.text();
    } catch (failure) {
      consumedFailure = failure;
    }
    expect(Object.is(consumedFailure, hostileFailure)).toBe(true);
    expect(Object.is(captureException.mock.calls[0]?.[0], hostileFailure)).toBe(
      true
    );
    expect(captureException.mock.calls[0]?.[1]).toEqual({
      level: 'error',
      tags: { event: 'framework.stream.failed' },
    });
  });

  it('emits a sanitized fallback when telemetry is unavailable', async () => {
    const renderError = new Error('do not print this message');
    const consoleError = vi
      .spyOn(globalThis.console, 'error')
      .mockImplementation(() => undefined);
    renderer.renderToReadableStream.mockImplementationOnce(
      async (_node, options: { onError: (error: unknown) => void }) => {
        const stream = new ReadableStream({
          pull(controller) {
            options.onError(renderError);
            controller.error(renderError);
          },
        });
        Object.assign(stream, { allReady: Promise.resolve() });
        return stream;
      }
    );
    const { observedStreamHandler } =
      await import('@/runtime/observed-stream-handler');
    const result = await observedStreamHandler({
      request: new Request('https://app.example/'),
      responseHeaders: new Headers(),
      router: {
        options: {},
        stores: { statusCode: { get: () => 200 } },
      },
    } as never);

    await expect(
      (result as { response: Response }).response.text()
    ).rejects.toBe(renderError);
    expect(consoleError).toHaveBeenCalledWith('telemetry.report_failure', {
      errorType: 'Error',
      source: 'framework.stream.failed',
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain(
      renderError.message
    );
  });
});
