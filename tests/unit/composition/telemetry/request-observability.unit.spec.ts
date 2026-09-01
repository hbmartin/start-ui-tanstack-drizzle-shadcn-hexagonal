import { afterEach, describe, expect, it, vi } from 'vitest';
import { context, propagation } from '@opentelemetry/api';

import { observeHttpRequest } from '@/composition/telemetry/request-observability';
import {
  createNoOpTelemetry,
  setTelemetry,
  type TelemetryAdapter,
} from '@/platform/telemetry';

afterEach(() => {
  setTelemetry(createNoOpTelemetry());
  vi.restoreAllMocks();
});

describe('request observability', () => {
  it('wraps non-telemetry requests in a root span and records duration', async () => {
    const telemetry: TelemetryAdapter = {
      ...createNoOpTelemetry(),
      recordMetric: vi.fn(),
      startSpan: vi.fn((_options, fn) => fn()),
    };
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(35);
    setTelemetry(telemetry);

    const result = await observeHttpRequest(
      {
        handlerType: 'router',
        pathname: '/manager/books/c12345678901234567890',
        requestId: 'request-1',
        request: new Request(
          'https://app.example/manager/books/c12345678901234567890',
          { method: 'GET' }
        ),
      },
      async () => ({ response: new Response('ok', { status: 200 }) })
    );

    expect(result.response.status).toBe(200);
    expect(telemetry.startSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'http.request.method': 'GET',
          'http.route': '/unmatched',
          'app.request_id': 'request-1',
          'tanstack.handler_type': 'router',
        }),
        name: 'http.request',
        op: 'http.server',
      }),
      expect.any(Function)
    );
    expect(telemetry.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'http.response.status_class': '2xx',
          'http.response.status_code': 200,
          'http.route': '/unmatched',
          status: 'success',
        }),
        name: 'app.http.request.duration',
        value: 25,
      })
    );
    expect(
      vi.mocked(telemetry.recordMetric).mock.calls[0]?.[0].attributes
    ).not.toHaveProperty('app.request_id');
  });

  it('does not wrap telemetry export requests', async () => {
    const telemetry: TelemetryAdapter = {
      ...createNoOpTelemetry(),
      recordMetric: vi.fn(),
      startSpan: vi.fn((_options, fn) => fn()),
    };
    setTelemetry(telemetry);

    const result = observeHttpRequest(
      {
        handlerType: 'router',
        pathname: '/api/telemetry/otel/v1/traces',
        request: new Request(
          'https://app.example/api/telemetry/otel/v1/traces'
        ),
      },
      () => 'ok'
    );

    expect(result).toBe('ok');
    expect(telemetry.startSpan).not.toHaveBeenCalled();
    expect(telemetry.recordMetric).not.toHaveBeenCalled();
  });

  it('records an error metric with response status and rethrows when next rejects', async () => {
    const telemetry: TelemetryAdapter = {
      ...createNoOpTelemetry(),
      recordMetric: vi.fn(),
      startSpan: vi.fn((_options, fn) => fn()),
    };
    vi.spyOn(performance, 'now')
      .mockReturnValueOnce(10)
      .mockReturnValueOnce(45);
    setTelemetry(telemetry);
    const thrown = { response: new Response('denied', { status: 403 }) };

    await expect(
      observeHttpRequest(
        {
          handlerType: 'router',
          pathname: '/manager/books/c12345678901234567890',
          request: new Request(
            'https://app.example/manager/books/c12345678901234567890',
            { method: 'GET' }
          ),
        },
        async () => {
          throw thrown;
        }
      )
    ).rejects.toBe(thrown);

    expect(telemetry.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          'http.response.status_class': '4xx',
          'http.response.status_code': 403,
          status: 'error',
        }),
        name: 'app.http.request.duration',
        value: 35,
      })
    );
  });

  it('captures unexpected failures while the request span is active', async () => {
    let spanActive = false;
    const captureException = vi.fn(() => {
      expect(spanActive).toBe(true);
    });
    const startSpan = vi.fn(async (_options, fn) => {
      spanActive = true;
      try {
        return await fn();
      } finally {
        spanActive = false;
      }
    });
    const telemetry: TelemetryAdapter = {
      ...createNoOpTelemetry(),
      captureException,
      startSpan: startSpan as unknown as TelemetryAdapter['startSpan'],
    };
    setTelemetry(telemetry);
    const error = new Error('render failed');

    await expect(
      observeHttpRequest(
        {
          handlerType: 'router',
          pathname: '/users/person@example.com',
          request: new Request('https://app.example/users/person@example.com'),
        },
        async () => {
          throw error;
        }
      )
    ).rejects.toBe(error);

    expect(captureException).toHaveBeenCalledOnce();
    expect(captureException).toHaveBeenCalledWith(error, {
      level: 'error',
      tags: { event: 'framework.request.failed' },
    });
    expect(JSON.stringify(startSpan.mock.calls)).not.toMatch(
      /person@example\.com/u
    );
  });

  it('preserves hostile application values during telemetry inspection', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const hostileResult = Object.defineProperty(
      {},
      // oxlint-disable-next-line unicorn/no-thenable -- Regression fixture for application-owned thenable identity.
      'then',
      {
        get: () => {
          throw new Error('application then getter failed');
        },
      }
    );
    const hostileFailure = Object.defineProperty({}, 'response', {
      get: () => {
        throw new Error('response getter failed');
      },
    });

    expect(
      observeHttpRequest(
        {
          handlerType: 'router',
          pathname: '/hostile',
          request: new Request('https://app.example/hostile'),
        },
        () => hostileResult
      )
    ).toBe(hostileResult);
    expect(() =>
      observeHttpRequest(
        {
          handlerType: 'router',
          pathname: '/hostile',
          request: new Request('https://app.example/hostile'),
        },
        () => {
          throw hostileFailure;
        }
      )
    ).toThrow(hostileFailure);
  });

  it('records per-request capture ownership for primitive failures', () => {
    const captureState = { captured: new Set<unknown>() };

    expect(() =>
      observeHttpRequest(
        {
          captureState,
          handlerType: 'router',
          pathname: '/failed',
          request: new Request('https://app.example/failed'),
        },
        () => {
          throw 'primitive failure';
        }
      )
    ).toThrow('primitive failure');
    expect(captureState.captured.has('primitive failure')).toBe(true);
  });

  it('preserves the original response when span completion and metric export fail', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const telemetry: TelemetryAdapter = {
      ...createNoOpTelemetry(),
      recordMetric: vi.fn(() => {
        throw new Error('metric export failed');
      }),
      startSpan: vi.fn((_options, work) => {
        work();
        throw new Error('span completion failed');
      }),
    };
    const originalResponse = new Response('forbidden', { status: 403 });
    const next = vi.fn(() => ({ response: originalResponse }));
    setTelemetry(telemetry);

    const result = observeHttpRequest(
      {
        handlerType: 'router',
        pathname: '/manager/books',
        request: new Request('https://app.example/manager/books'),
      },
      next
    );

    expect(result.response).toBe(originalResponse);
    expect(result.response.body).toBe(originalResponse.body);
    expect(next).toHaveBeenCalledOnce();
  });

  it('runs application work once when propagation extraction fails', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    vi.spyOn(propagation, 'extract').mockImplementation(() => {
      throw new Error('propagator unavailable');
    });
    const applicationResponse = new Response('available');
    const next = vi.fn(() => applicationResponse);

    const result = observeHttpRequest(
      {
        handlerType: 'router',
        pathname: '/available',
        request: new Request('https://app.example/available'),
      },
      next
    );

    expect(result).toBe(applicationResponse);
    expect(next).toHaveBeenCalledOnce();
  });

  it('preserves the application result when context activation fails afterward', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    vi.spyOn(context, 'with').mockImplementation((_active, work) => {
      work();
      throw new Error('context manager failed after work');
    });
    const applicationResponse = new Response('available');
    const next = vi.fn(() => applicationResponse);

    const result = observeHttpRequest(
      {
        handlerType: 'router',
        pathname: '/available',
        request: new Request('https://app.example/available'),
      },
      next
    );

    expect(result).toBe(applicationResponse);
    expect(next).toHaveBeenCalledOnce();
  });

  it('runs application work when context activation skips its callback', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    vi.spyOn(context, 'with').mockImplementation(
      () => new Response('provider substitute')
    );
    const applicationResponse = new Response('available');
    const next = vi.fn(() => applicationResponse);

    const result = observeHttpRequest(
      {
        handlerType: 'router',
        pathname: '/available',
        request: new Request('https://app.example/available'),
      },
      next
    );

    expect(result).toBe(applicationResponse);
    expect(next).toHaveBeenCalledOnce();
  });

  it('drains a rejected context result when activation skips its callback', async () => {
    const report = vi
      .spyOn(globalThis.console, 'error')
      .mockImplementation(() => undefined);
    const providerFailure = new Error('provider substitute failed');
    vi.spyOn(context, 'with').mockImplementation(
      () => Promise.reject(providerFailure) as never
    );
    const applicationResponse = new Response('available');
    const next = vi.fn(() => applicationResponse);

    const result = observeHttpRequest(
      {
        handlerType: 'router',
        pathname: '/available',
        request: new Request('https://app.example/available'),
      },
      next
    );
    await Promise.resolve();

    expect(result).toBe(applicationResponse);
    expect(next).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledTimes(3);
    expect(report).toHaveBeenLastCalledWith('telemetry.report_failure', {
      errorType: 'Error',
      source: 'otel.context.activate',
    });
  });

  it('ignores a context manager result substituted after application work', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const providerResponse = new Response('provider substitute');
    vi.spyOn(context, 'with').mockImplementation((_active, work) => {
      work();
      return providerResponse;
    });
    const applicationResponse = new Response('available');
    const next = vi.fn(() => applicationResponse);

    const result = observeHttpRequest(
      {
        handlerType: 'router',
        pathname: '/available',
        request: new Request('https://app.example/available'),
      },
      next
    );

    expect(result).toBe(applicationResponse);
    expect(result).not.toBe(providerResponse);
    expect(next).toHaveBeenCalledOnce();
  });
});
