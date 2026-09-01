import { beforeEach, describe, expect, it, vi } from 'vitest';

const otelMocks = vi.hoisted(() => {
  const state = {
    activeSpan: undefined as
      | {
          recordException: ReturnType<typeof vi.fn>;
          setAttribute: ReturnType<typeof vi.fn>;
          setStatus: ReturnType<typeof vi.fn>;
          spanContext: ReturnType<typeof vi.fn>;
        }
      | undefined,
    startedSpan: undefined as
      | {
          end: ReturnType<typeof vi.fn>;
          recordException: ReturnType<typeof vi.fn>;
          setAttribute: ReturnType<typeof vi.fn>;
          setStatus: ReturnType<typeof vi.fn>;
          spanContext: ReturnType<typeof vi.fn>;
        }
      | undefined,
  };

  const counterAdd = vi.fn();
  const histogramRecord = vi.fn();
  const createCounter = vi.fn(() => ({ add: counterAdd }));
  const createHistogram = vi.fn(() => ({ record: histogramRecord }));
  const getMeter = vi.fn(() => ({ createCounter, createHistogram }));
  const emit = vi.fn();
  const getLogger = vi.fn(() => ({ emit }));
  const startActiveSpan = vi.fn((_name, _options, fn) => {
    const span = {
      end: vi.fn(),
      recordException: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      spanContext: vi.fn(() => ({
        spanId: 'started-span',
        traceFlags: 1,
        traceId: 'started-trace',
      })),
    };
    state.startedSpan = span;
    return fn(span);
  });
  const startSpan = vi.fn(() => ({
    addEvent: vi.fn(),
    end: vi.fn(),
    recordException: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    setStatus: vi.fn(),
  }));
  const getTracer = vi.fn(() => ({ startActiveSpan, startSpan }));

  return {
    activeContext: { trace: 'active-context' },
    counterAdd,
    createCounter,
    emit,
    getActiveSpan: vi.fn(() => state.activeSpan),
    getLogger,
    getMeter,
    getTracer,
    histogramRecord,
    startActiveSpan,
    startSpan,
    state,
  };
});

vi.mock('@opentelemetry/api', () => ({
  context: {
    active: vi.fn(() => otelMocks.activeContext),
  },
  metrics: {
    getMeter: otelMocks.getMeter,
  },
  SpanStatusCode: {
    ERROR: 'ERROR',
    OK: 'OK',
    UNSET: 'UNSET',
  },
  trace: {
    getActiveSpan: otelMocks.getActiveSpan,
    getTracer: otelMocks.getTracer,
  },
  TraceFlags: {
    SAMPLED: 1,
  },
}));

vi.mock('@opentelemetry/api-logs', () => ({
  logs: {
    getLogger: otelMocks.getLogger,
  },
  SeverityNumber: {
    DEBUG: 5,
    ERROR: 17,
    FATAL: 21,
    INFO: 9,
    WARN: 13,
  },
}));

describe('createOpenTelemetryAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    otelMocks.state.activeSpan = undefined;
    otelMocks.state.startedSpan = undefined;
  });

  it('marks the active span and emits one OTel log without an exception event', async () => {
    const activeSpan = {
      recordException: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      spanContext: vi.fn(() => ({
        spanId: 'span-1',
        traceId: 'trace-1',
      })),
    };
    otelMocks.state.activeSpan = activeSpan;
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();
    adapter.setUser({ id: 'user-1' });
    const error = new Error('provider failed');

    adapter.captureException(error, {
      extra: { statusCode: 500 },
      fingerprint: ['auth'],
      level: 'warning',
      tags: { event: 'auth.failure', provider: 'better-auth' },
    });

    expect(activeSpan.recordException).not.toHaveBeenCalled();
    expect(activeSpan.setAttribute).toHaveBeenCalledWith('error.type', 'Error');
    expect(activeSpan.setStatus).toHaveBeenCalledWith({ code: 'ERROR' });
    expect(otelMocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        attributes: expect.objectContaining({
          event: 'auth.failure',
          provider: 'better-auth',
          'span.id': 'span-1',
          'trace.id': 'trace-1',
        }),
        body: {
          error: {
            causes: [{ type: 'Error' }],
            truncated: false,
          },
          event: 'auth.failure',
        },
        context: otelMocks.activeContext,
        eventName: 'auth.failure',
        severityNumber: 13,
        severityText: 'WARN',
      })
    );
    const emitted = otelMocks.emit.mock.calls[0]?.[0];
    expect(emitted.attributes).not.toHaveProperty('extra');
    expect(emitted.attributes).not.toHaveProperty('fingerprint');
    expect(emitted.attributes).not.toHaveProperty('user.id');
  });

  it('exports only bounded allowlisted attributes and never arbitrary payloads', async () => {
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();

    adapter.captureException(new Error('Bearer exception-secret'), {
      extra: {
        href: '/account?token=query-secret',
        medicalNote: 'confidential diagnosis',
        payload: 'Bearer context-secret',
      },
      tags: {
        event: 'security.failed',
        payload: 'Bearer tag-secret',
      },
    });
    adapter.emitLog({
      attributes: {
        requestId: 'request-1',
        secretField: 'sk-secretvalue',
      },
      details: { medicalNote: 'confidential diagnosis' },
      event: 'security.failed',
      level: 'error',
      message: 'Bearer log-secret',
    });
    adapter.recordMetric({
      attributes: {
        'http.route': '/account',
        'user.id_hash': 'hdeadbeef',
      },
      name: 'app.request',
      type: 'counter',
      value: 1,
    });

    const exported = JSON.stringify({
      logs: otelMocks.emit.mock.calls,
      metrics: otelMocks.counterAdd.mock.calls,
    });
    expect(exported).not.toMatch(
      /context-secret|diagnosis|exception-secret|log-secret|query-secret|secretvalue|tag-secret|token=|user\.id/u
    );
    expect(otelMocks.counterAdd).toHaveBeenCalledWith(1, {
      'http.route': '/account',
    });
  });

  it('projects caller-controlled span, metric, and unit names onto closed labels', async () => {
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();

    adapter.startSpan(
      {
        name: 'GET /users/person@example.com?token=query-secret',
        op: 'http.server',
      },
      () => 'done'
    );
    adapter.startManualSpan({
      name: 'router.navigation /reset/query-secret',
      op: 'router.navigation',
    });
    adapter.recordMetric({
      name: 'person@example.com',
      type: 'counter',
      unit: 'query-secret',
      value: 1,
    });

    expect(otelMocks.startActiveSpan).toHaveBeenCalledWith(
      'http.request',
      expect.any(Object),
      expect.any(Function)
    );
    expect(otelMocks.startSpan).toHaveBeenCalledWith(
      'router.navigation',
      expect.any(Object)
    );
    expect(otelMocks.createCounter).toHaveBeenCalledWith(
      'application.counter',
      {}
    );
    expect(
      JSON.stringify({
        metrics: otelMocks.createCounter.mock.calls,
        spans: [
          ...otelMocks.startActiveSpan.mock.calls,
          ...otelMocks.startSpan.mock.calls,
        ],
      })
    ).not.toMatch(/person@example\.com|query-secret/u);
  });

  it('emits one OTel error log and one Sentry exception for a handled error', async () => {
    const activeSpan = {
      recordException: vi.fn(),
      setAttribute: vi.fn(),
      setStatus: vi.fn(),
      spanContext: vi.fn(() => ({ spanId: 'span-1', traceId: 'trace-1' })),
    };
    otelMocks.state.activeSpan = activeSpan;
    const { createTelemetryAdapterChain } =
      await import('@/composition/telemetry/adapter-chain');
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const { createSentryTelemetryAdapter } =
      await import('@/composition/telemetry/sentry-adapter');
    const sentryCapture = vi.fn(() => 'event-1');
    const adapter = createTelemetryAdapterChain([
      createOpenTelemetryAdapter(),
      createSentryTelemetryAdapter({
        captureException: sentryCapture,
        setUser: vi.fn(),
      }),
    ]);
    const error = new Error('handled failure');

    adapter.captureException(error, {
      level: 'error',
      tags: { event: 'application.failed' },
    });

    expect(otelMocks.emit).toHaveBeenCalledOnce();
    expect(sentryCapture).toHaveBeenCalledOnce();
    expect(activeSpan.recordException).not.toHaveBeenCalled();
    expect(activeSpan.setStatus).toHaveBeenCalledWith({ code: 'ERROR' });
  });

  it('normalizes structured log severity text to OTel labels', async () => {
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();

    adapter.emitLog({ event: 'quota.near_limit', level: 'warn' });

    expect(otelMocks.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        eventName: 'quota.near_limit',
        severityNumber: 13,
        severityText: 'WARN',
      })
    );
  });

  it('does not serialize captured error messages into OTel logs', async () => {
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();

    adapter.captureException({ message: 'provider payload failed' });

    const emitted = otelMocks.emit.mock.calls[0]?.[0];
    expect(emitted).toEqual(
      expect.objectContaining({
        body: {
          error: {
            causes: [{ type: 'object' }],
            truncated: false,
          },
          event: 'exception.captured',
        },
        eventName: 'exception.captured',
        severityNumber: 17,
        severityText: 'ERROR',
      })
    );
    expect(emitted).not.toHaveProperty('exception');
  });

  it('exports only bounded classifications from the original cause chain', async () => {
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();

    const databaseError = Object.assign(new Error('db secret'), {
      code: 'DB_UNAVAILABLE',
      name: 'DatabaseError',
    });
    const providerError = Object.assign(
      new Error('provider secret', { cause: databaseError }),
      { name: 'ProviderError' }
    );
    const appError = Object.assign(
      new Error('outer secret', { cause: providerError }),
      {
        category: 'system',
        code: 'AUTH_PROVIDER_FAILED',
        name: 'AppError',
      }
    );

    adapter.captureException(appError, {
      tags: { event: 'application.failed' },
    });

    const emitted = otelMocks.emit.mock.calls[0]?.[0];
    expect(emitted.body).toEqual({
      error: {
        causes: [
          {
            category: 'system',
            code: 'AUTH_PROVIDER_FAILED',
            type: 'AppError',
          },
          { type: 'ProviderError' },
          { code: 'DB_UNAVAILABLE', type: 'DatabaseError' },
        ],
        truncated: false,
      },
      event: 'application.failed',
    });
    expect(JSON.stringify(emitted)).not.toMatch(
      /outer secret|provider secret|db secret/u
    );
  });

  it('bounds cycles, depth, and hostile cause access without throwing', async () => {
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();
    const cycle = Object.assign(new Error('cycle secret'), {
      name: 'CycleError',
    });
    Object.defineProperty(cycle, 'cause', { value: cycle });

    expect(() => adapter.captureException(cycle)).not.toThrow();
    expect(otelMocks.emit.mock.calls[0]?.[0].body).toEqual({
      error: {
        causes: [{ type: 'CycleError' }],
        truncated: true,
      },
      event: 'exception.captured',
    });

    vi.clearAllMocks();
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('hostile getter secret');
        },
        getPrototypeOf() {
          throw new Error('prototype secret');
        },
      }
    );

    expect(() => adapter.captureException(hostile)).not.toThrow();
    expect(otelMocks.emit.mock.calls[0]?.[0].body).toEqual({
      error: {
        causes: [{ type: 'uninspectable' }],
        truncated: true,
      },
      event: 'exception.captured',
    });
    expect(JSON.stringify(otelMocks.emit.mock.calls)).not.toMatch(
      /cycle secret|cause getter secret|name getter secret|prototype secret/u
    );
  });

  it('marks Boxed Result.Error span returns as failed operations', async () => {
    const { Result } = await import('@bloodyowl/boxed');
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();
    const error = new Error('provider failed');

    const result = await adapter.startSpan(
      { name: 'auth.userHasPermission', op: 'auth.provider' },
      async () => Result.Error(error)
    );

    expect(result.isError()).toBe(true);
    expect(otelMocks.state.startedSpan?.recordException).not.toHaveBeenCalled();
    expect(otelMocks.state.startedSpan?.setAttribute).toHaveBeenCalledWith(
      'error.type',
      'Error'
    );
    expect(otelMocks.state.startedSpan?.setStatus).toHaveBeenCalledWith({
      code: 'ERROR',
    });
    expect(otelMocks.state.startedSpan?.end).toHaveBeenCalledTimes(1);
  });

  it('emits captured exceptions as OTel logs when no span is active', async () => {
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();

    adapter.captureException('string failure');

    const emitted = otelMocks.emit.mock.calls[0]?.[0];
    expect(emitted).toEqual(
      expect.objectContaining({
        body: {
          error: {
            causes: [{ type: 'string' }],
            truncated: false,
          },
          event: 'exception.captured',
        },
        eventName: 'exception.captured',
        severityNumber: 17,
        severityText: 'ERROR',
      })
    );
    expect(emitted).not.toHaveProperty('exception');
  });

  it('resolves tracer, meter, and logger lazily after adapter construction', async () => {
    const { createOpenTelemetryAdapter } =
      await import('@/composition/telemetry/otel-adapter');
    const adapter = createOpenTelemetryAdapter();

    expect(otelMocks.getTracer).not.toHaveBeenCalled();
    expect(otelMocks.getMeter).not.toHaveBeenCalled();
    expect(otelMocks.getLogger).not.toHaveBeenCalled();

    adapter.startSpan({ name: 'lazy.span' }, () => 'done');
    adapter.recordMetric({ name: 'lazy.metric', type: 'counter', value: 1 });
    adapter.emitLog({ event: 'lazy.log', level: 'info' });

    expect(otelMocks.getTracer).toHaveBeenCalledWith('start-ui-web');
    expect(otelMocks.getMeter).toHaveBeenCalledWith('start-ui-web');
    expect(otelMocks.getLogger).toHaveBeenCalledWith('start-ui-web');
    expect(otelMocks.counterAdd).toHaveBeenCalledWith(1, {});
  });
});
