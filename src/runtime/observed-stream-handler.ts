import { createElement } from 'react';
import ReactDOMServer from 'react-dom/server';
import { isbot } from 'isbot';
import {
  StartServer,
  defineHandlerCallback,
  transformReadableStreamWithRouter,
} from '@tanstack/react-start/server';
import { createSsrStreamResponse } from '@tanstack/react-router/ssr/server';

import {
  claimRequestException,
  createRequestExceptionCaptureState,
  getRequestExceptionState,
  isTelemetryAvailable,
  reportTelemetryFailure,
  telemetryProxy,
} from '@/platform/telemetry';

import { registerRequestCompletion } from './request-completion';

const noop = () => {};

const isAbortError = (request: Request, error: unknown) => {
  try {
    return (
      (request.signal.aborted && error === request.signal.reason) ||
      (error instanceof Error && error.name === 'AbortError')
    );
  } catch {
    return false;
  }
};

const waitForReadyOrAbort = async (
  ready: Promise<unknown>,
  signal: AbortSignal
) => {
  let cleanup = noop;
  try {
    await Promise.race([
      ready,
      new Promise<void>((resolve) => {
        const onAbort = () => resolve();
        cleanup = () => signal.removeEventListener('abort', onAbort);
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) resolve();
      }),
    ]);
  } finally {
    cleanup();
  }
};

/**
 * TanStack's default stream handler logs React renderer errors but exposes no
 * observation hook. This equivalent handler owns React's producer callback so
 * failures are captured before the response stream reports them to a consumer.
 * It returns TanStack's original Response and body without wrapping either.
 */
export const observedStreamHandler = defineHandlerCallback(
  async ({ request, responseHeaders, router }) => {
    const exceptionCaptureState =
      getRequestExceptionState(request) ?? createRequestExceptionCaptureState();
    const stream = await ReactDOMServer.renderToReadableStream(
      createElement(StartServer, { router }),
      {
        signal: request.signal,
        nonce: router.options.ssr?.nonce,
        progressiveChunkSize: Number.POSITIVE_INFINITY,
        onError: (error) => {
          if (
            isAbortError(request, error) ||
            !claimRequestException(exceptionCaptureState, error)
          ) {
            return;
          }
          if (!isTelemetryAvailable()) {
            reportTelemetryFailure('framework.stream.failed', error);
          }
          telemetryProxy.captureException(error, {
            level: 'error',
            tags: { event: 'framework.stream.failed' },
          });
        },
      }
    );
    registerRequestCompletion(request, stream.allReady);

    if (isbot(request.headers.get('user-agent'))) {
      await waitForReadyOrAbort(stream.allReady, request.signal);
    }

    type RouterReadableStream = Parameters<
      typeof transformReadableStreamWithRouter
    >[1];
    const responseStream = transformReadableStreamWithRouter(
      router,
      stream as unknown as RouterReadableStream,
      {
        onAbort: () => stream.cancel().catch(noop),
      }
    );
    const response = new Response(responseStream as unknown as BodyInit, {
      headers: responseHeaders,
      status: router.stores.statusCode.get(),
    });

    return createSsrStreamResponse(router, response);
  }
);
