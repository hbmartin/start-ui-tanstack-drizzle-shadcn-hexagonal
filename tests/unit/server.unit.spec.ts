import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const order: string[] = [];

  return {
    createServerEntry: vi.fn((entry: unknown) => {
      order.push('tanstack');
      return entry;
    }),
    handlerFetch: vi.fn(
      async (_request?: Request, _options?: unknown) => new Response('ok')
    ),
    initNodeTelemetry: vi.fn(() => order.push('telemetry')),
    order,
    runWithNodeSentryRequestIsolation: vi.fn(
      <T>(operation: () => T): T => operation()
    ),
    reportTelemetryFailure: vi.fn(),
    telemetryCaptureException: vi.fn(),
    validateServerConfig: vi.fn(() => order.push('config')),
  };
});

vi.mock('@/entry-server', () => ({
  default: {
    fetch: mocks.handlerFetch,
  },
  createServerEntry: mocks.createServerEntry,
}));

vi.mock('@/modules/kernel/backend', () => ({
  validateServerConfig: mocks.validateServerConfig,
}));

vi.mock('@/runtime/node/telemetry', () => ({
  initNodeTelemetry: mocks.initNodeTelemetry,
  runWithNodeSentryRequestIsolation: mocks.runWithNodeSentryRequestIsolation,
}));

vi.mock('@/platform/telemetry', () => ({
  bindRequestExceptionState: vi.fn(),
  claimRequestException: (
    state: { captured: Set<unknown> },
    failure: unknown
  ) => {
    if (state.captured.has(failure)) return false;
    state.captured.add(failure);
    return true;
  },
  createRequestExceptionCaptureState: () => ({ captured: new Set() }),
  reportTelemetryFailure: mocks.reportTelemetryFailure,
  telemetryProxy: {
    captureException: mocks.telemetryCaptureException,
  },
}));

describe('server entry', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.handlerFetch.mockImplementation(async () => new Response('ok'));
    mocks.runWithNodeSentryRequestIsolation.mockImplementation(
      <T>(operation: () => T): T => operation()
    );
  });

  it('passes a request id through Start request context', async () => {
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };
    const request = new Request('https://app.example/');

    await server.fetch(request);

    expect(mocks.handlerFetch).toHaveBeenCalledWith(
      request,
      expect.objectContaining({
        context: expect.objectContaining({
          requestId: expect.any(String),
          runtimeProfile: 'node',
          telemetryCaptureState: { captured: expect.any(Set) },
        }),
      })
    );
    expect(mocks.runWithNodeSentryRequestIsolation).toHaveBeenCalledOnce();
  });

  it('runs fail-closed config validation at boot (H1 regression)', async () => {
    await import('@/server');

    expect(mocks.validateServerConfig).toHaveBeenCalledTimes(1);
    expect(mocks.validateServerConfig).toHaveBeenCalledWith('node');
  });

  it('installs telemetry before TanStack evaluates and does so once', async () => {
    await import('@/server');

    expect(mocks.order).toEqual(['config', 'telemetry', 'tanstack']);
    expect(mocks.initNodeTelemetry).toHaveBeenCalledOnce();
  });

  it('keeps instrumentation before config, telemetry, and TanStack imports', () => {
    const profileSource = readFileSync(
      new URL('../../src/runtime/node/server-entry.ts', import.meta.url),
      'utf8'
    );
    const commonSource = readFileSync(
      new URL(
        '../../src/runtime/create-application-server-entry.ts',
        import.meta.url
      ),
      'utf8'
    );
    const instrumentationIndex = profileSource.indexOf(
      "await import('../../../instrument.server.mjs')"
    );
    const configIndex = profileSource.indexOf(
      "await import('@/modules/kernel/backend')"
    );
    const telemetryIndex = profileSource.indexOf("await import('./telemetry')");
    const commonEntryIndex = profileSource.indexOf(
      "await import('../create-application-server-entry')"
    );
    const tanstackIndex = commonSource.indexOf(
      "await import('@/entry-server')"
    );

    expect(instrumentationIndex).toBeGreaterThanOrEqual(0);
    expect(configIndex).toBeGreaterThan(instrumentationIndex);
    expect(telemetryIndex).toBeGreaterThan(configIndex);
    expect(commonEntryIndex).toBeGreaterThan(telemetryIndex);
    expect(tanstackIndex).toBeGreaterThanOrEqual(0);
    expect(commonSource).not.toMatch(
      /@sentry|otel\.server|instrument\.server/u
    );
  });

  it('captures uncaught framework exceptions once and preserves their identity', async () => {
    const failure = new Error('render failed');
    mocks.handlerFetch.mockRejectedValueOnce(failure);
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };

    await expect(
      server.fetch(new Request('https://app.example/private?token=secret'))
    ).rejects.toBe(failure);

    expect(mocks.telemetryCaptureException).toHaveBeenCalledOnce();
    expect(mocks.telemetryCaptureException).toHaveBeenCalledWith(failure, {
      level: 'error',
      tags: {
        event: 'framework.request.failed',
        requestId: expect.any(String),
      },
    });
  });

  it('does not recapture primitive failures already owned by request telemetry', async () => {
    const failure = 'primitive render failure';
    mocks.handlerFetch.mockImplementationOnce(async (_request, options) => {
      const requestOptions = options as {
        context: {
          telemetryCaptureState: { captured: Set<unknown> };
        };
      };
      requestOptions.context.telemetryCaptureState.captured.add(failure);
      throw failure;
    });
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };

    await expect(
      server.fetch(new Request('https://app.example/private'))
    ).rejects.toBe(failure);
    expect(mocks.telemetryCaptureException).not.toHaveBeenCalled();
  });

  it('does not report expected thrown 4xx responses as exceptions', async () => {
    const response = new Response('Not found', { status: 404 });
    mocks.handlerFetch.mockRejectedValueOnce(response);
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };

    await expect(
      server.fetch(new Request('https://app.example/missing'))
    ).rejects.toBe(response);
    expect(mocks.telemetryCaptureException).not.toHaveBeenCalled();
  });

  it('returns the exact streaming response produced by TanStack', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed'));
        controller.close();
      },
    });
    const response = new Response(stream, { status: 202 });
    mocks.handlerFetch.mockResolvedValueOnce(response);
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };

    const result = await server.fetch(new Request('https://app.example/'));

    expect(result).toBe(response);
    expect(result.body).toBe(stream);
    await expect(result.text()).resolves.toBe('streamed');
  });

  it('runs the app once when the optional request scope fails before entry', async () => {
    const scopeFailure = new Error('scope failed before entry');
    const response = new Response('scope fallback');
    mocks.handlerFetch.mockResolvedValueOnce(response);
    mocks.runWithNodeSentryRequestIsolation.mockImplementationOnce(() => {
      throw scopeFailure;
    });
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };

    await expect(
      server.fetch(new Request('https://app.example/'))
    ).resolves.toBe(response);
    expect(mocks.handlerFetch).toHaveBeenCalledOnce();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'sentry.request_scope',
      scopeFailure
    );
  });

  it('preserves the app failure when the request scope throws after entry', async () => {
    const appFailure = new Error('app failure');
    const scopeFailure = new Error('scope failed after entry');
    mocks.handlerFetch.mockRejectedValueOnce(appFailure);
    mocks.runWithNodeSentryRequestIsolation.mockImplementationOnce(
      <T>(operation: () => T): T => {
        operation();
        throw scopeFailure;
      }
    );
    const server = (await import('@/server')).default as {
      fetch: (request: Request) => Promise<Response>;
    };

    await expect(
      server.fetch(new Request('https://app.example/'))
    ).rejects.toBe(appFailure);
    expect(mocks.handlerFetch).toHaveBeenCalledOnce();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'sentry.request_scope',
      scopeFailure
    );
  });
});
