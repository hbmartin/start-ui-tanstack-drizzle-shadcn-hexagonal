import { beforeEach, describe, expect, it, vi } from 'vitest';

const sentryMocks = vi.hoisted(() => ({
  browserTracingIntegration: vi.fn(() => 'browser-tracing'),
  init: vi.fn(),
  tanstackRouterBrowserTracingIntegration: vi.fn(() => 'router-tracing'),
}));

const otelMocks = vi.hoisted(() => ({
  initOpenTelemetryClient: vi.fn(),
}));

const envClientMock = vi.hoisted(() => ({
  VITE_OTEL_BROWSER_ENABLED: false,
  VITE_SENTRY_DSN: '',
  VITE_SENTRY_ENVIRONMENT: undefined as string | undefined,
  VITE_SENTRY_TUNNEL_PATH: '/api/telemetry/sentry-tunnel',
  VITE_SENTRY_TRACES_SAMPLE_RATE: 0,
}));

vi.mock('@sentry/tanstackstart-react', () => ({
  browserTracingIntegration: sentryMocks.browserTracingIntegration,
  init: sentryMocks.init,
  tanstackRouterBrowserTracingIntegration:
    sentryMocks.tanstackRouterBrowserTracingIntegration,
}));

vi.mock('@/platform/env/client', () => ({
  envClient: envClientMock,
  getEnvClient: () => envClientMock,
}));

vi.mock('@/composition/telemetry/otel.client', () => ({
  initOpenTelemetryClient: otelMocks.initOpenTelemetryClient,
}));

describe('Sentry telemetry composition', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    envClientMock.VITE_SENTRY_DSN = '';
    envClientMock.VITE_SENTRY_ENVIRONMENT = undefined;
    envClientMock.VITE_SENTRY_TUNNEL_PATH = '/api/telemetry/sentry-tunnel';
    envClientMock.VITE_SENTRY_TRACES_SAMPLE_RATE = 0;
    otelMocks.initOpenTelemetryClient.mockReturnValue(undefined);
  });

  it('is a no-op when no client DSN is configured', async () => {
    const { initTelemetryClient } =
      await import('@/composition/telemetry/sentry.client');

    initTelemetryClient({});

    expect(sentryMocks.init).not.toHaveBeenCalled();
    expect(
      sentryMocks.tanstackRouterBrowserTracingIntegration
    ).not.toHaveBeenCalled();
  });

  it('configures browser Sentry for tunneled error capture without tracing', async () => {
    envClientMock.VITE_SENTRY_DSN = 'https://example.com/1';
    const { initTelemetryClient } =
      await import('@/composition/telemetry/sentry.client');

    initTelemetryClient();

    expect(sentryMocks.browserTracingIntegration).not.toHaveBeenCalled();
    expect(
      sentryMocks.tanstackRouterBrowserTracingIntegration
    ).not.toHaveBeenCalled();
    expect(sentryMocks.init).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeSend: expect.any(Function),
        enableLogs: false,
        integrations: [],
        sendDefaultPii: false,
        tracesSampleRate: 0,
        tunnel: '/api/telemetry/sentry-tunnel',
      })
    );
  });

  it('does not abort optional browser bootstrap when Sentry initialization fails', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    envClientMock.VITE_SENTRY_DSN = 'https://example.com/1';
    sentryMocks.init.mockImplementationOnce(() => {
      throw new Error('Sentry unavailable');
    });
    const { initTelemetryClient } =
      await import('@/composition/telemetry/sentry.client');

    expect(() => initTelemetryClient()).not.toThrow();
    expect(globalThis.console.error).toHaveBeenCalledWith(
      'telemetry.report_failure',
      expect.objectContaining({
        errorType: 'Error',
        source: 'sentry.client.initialize',
      })
    );
  });

  it('keeps browser Sentry available when optional OTel initialization fails', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    envClientMock.VITE_SENTRY_DSN = 'https://example.com/1';
    otelMocks.initOpenTelemetryClient.mockImplementationOnce(() => {
      throw new Error('OTel unavailable');
    });
    const { initTelemetryClient } =
      await import('@/composition/telemetry/sentry.client');

    expect(() => initTelemetryClient()).not.toThrow();
    expect(sentryMocks.init).toHaveBeenCalledOnce();
    expect(globalThis.console.error).toHaveBeenCalledWith(
      'telemetry.report_failure',
      expect.objectContaining({
        errorType: 'Error',
        source: 'otel.client.initialize',
      })
    );
  });

  it('passes allowlisted tags and active OTel correlation to Sentry', async () => {
    const { createSentryTelemetryAdapter } =
      await import('@/composition/telemetry/sentry-adapter');
    const captureException = vi.fn(() => 'event-id');
    const adapter = createSentryTelemetryAdapter(
      {
        captureException,
        setUser: vi.fn(),
        setTag: vi.fn(),
        startSpan: vi.fn((_options, fn) => fn()),
      },
      {
        currentCorrelation: () => ({
          spanId: 'b'.repeat(16),
          traceId: 'a'.repeat(32),
        }),
      }
    );
    const error = new Error('boom');

    adapter.captureException(error, {
      fingerprint: ['email-send'],
      level: 'error',
      tags: { attempt: 2, event: 'email.send.failed', retryable: false },
      extra: { statusCode: 401 },
    });

    expect(captureException).toHaveBeenCalledWith(error, {
      level: 'error',
      tags: {
        attempt: '2',
        event: 'email.send.failed',
        'otel.span_id': 'b'.repeat(16),
        'otel.trace_id': 'a'.repeat(32),
        retryable: 'false',
      },
    });
  });

  it('projects Sentry events onto closed tags and trace context', async () => {
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');

    expect(
      sanitizeSentryEvent({
        contexts: {
          request: {
            authorization: 'Bearer token',
          },
          trace: {
            data: { payload: 'confidential diagnosis' },
            op: 'http.server',
            span_id: 'b'.repeat(16),
            trace_id: 'a'.repeat(32),
          },
        },
        extra: {
          email: 'person@example.com',
        },
        tags: {
          attempt: 2,
          email: 'person@example.com',
          event: 'email.send.failed',
          retryable: false,
        },
      })
    ).toEqual({
      contexts: {
        trace: {
          op: 'http.server',
          span_id: 'b'.repeat(16),
          trace_id: 'a'.repeat(32),
        },
      },
      tags: {
        attempt: '2',
        event: 'email.send.failed',
        retryable: 'false',
      },
    });
  });

  it('drops request secrets and sanitizes full exception events', async () => {
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');

    const sanitized = sanitizeSentryEvent({
      breadcrumbs: [
        {
          category: 'fetch',
          data: { authorization: 'Bearer breadcrumb-token' },
          level: 'error',
          message: 'person@example.com signed in with breadcrumb-token',
          type: 'http',
        },
      ],
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  filename: 'https://cdn.example/app.js?token=frame-token',
                  lineno: 42,
                  vars: {
                    medicalNote: 'confidential diagnosis',
                    token: 'frame-token',
                  },
                },
              ],
            },
            type: 'Error',
            value: 'Bearer exception-token for person@example.com',
          },
        ],
      },
      message: 'Bearer message-token for person@example.com',
      platform: 'confidential diagnosis',
      request: {
        cookies: { session: 'cookie-token' },
        data: { password: 'password-value' },
        headers: { authorization: 'Bearer request-token' },
        method: 'POST',
        query_string: 'token=query-token',
        url: 'https://app.example/account?token=query-token',
      },
      user: {
        email: 'person@example.com',
        id: 'user-1',
        ip_address: '203.0.113.2',
      },
      transaction: 'confidential diagnosis',
    });

    expect(sanitized).toEqual(
      expect.objectContaining({
        breadcrumbs: [{ category: 'fetch', level: 'error', type: 'http' }],
        exception: {
          values: [
            expect.objectContaining({
              stacktrace: {
                frames: [{ filename: '/app.js', lineno: 42 }],
              },
              type: 'Error',
              value: 'Unexpected application error',
            }),
          ],
        },
        message: 'Unexpected application error',
        request: { method: 'POST' },
      })
    );
    expect(JSON.stringify(sanitized)).not.toMatch(
      /breadcrumb-token|confidential diagnosis|exception-token|frame-token|message-token|request-token|query-token|cookie-token|password-value|person@example.com|user-1/u
    );
  });

  it('preserves source-map identity while rejecting hostile release metadata', async () => {
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');
    const debugId = '01234567-89ab-cdef-0123-456789abcdef';
    const codeFile = 'https://cdn.example/assets/app.js?token=secret';

    const sanitized = sanitizeSentryEvent({
      debug_meta: {
        images: [
          ...Array.from({ length: 50 }, (_, index) => ({
            code_file: `https://cdn.example/assets/unmatched-${index}.js`,
            debug_id: `00000000-0000-4000-8000-${index.toString().padStart(12, '0')}`,
            type: 'sourcemap',
          })),
          { code_file: codeFile, debug_id: debugId, type: 'sourcemap' },
          { code_file: codeFile, debug_id: debugId, type: 'sourcemap' },
          {
            code_file: 'https://cdn.example/assets/other.js',
            debug_id: 'fedcba98-7654-3210-fedc-ba9876543210',
            type: 'sourcemap',
          },
          { code_file: codeFile, debug_id: '0'.repeat(32), type: 'sourcemap' },
          { code_file: codeFile, debug_id: debugId, type: 'wasm' },
        ],
      },
      environment: 'production',
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  abs_path: codeFile,
                  filename: codeFile,
                },
              ],
            },
            type: 'Error',
          },
        ],
      },
      release: 'start-ui-web@5.0.0-alpha.1+7308e9c2',
    });

    expect(sanitized).toMatchObject({
      debug_meta: {
        images: [
          {
            code_file: '/assets/app.js',
            debug_id: debugId,
            type: 'sourcemap',
          },
        ],
      },
      environment: 'production',
      exception: {
        values: [
          {
            stacktrace: {
              frames: [
                {
                  abs_path: '/assets/app.js',
                  filename: '/assets/app.js',
                },
              ],
            },
            type: 'Error',
          },
        ],
      },
      release: 'start-ui-web@5.0.0-alpha.1+7308e9c2',
    });

    const rejected = sanitizeSentryEvent({
      debug_meta: {
        images: [
          {
            code_file: codeFile,
            debug_id: 'not-a-debug-id',
            type: 'sourcemap',
          },
        ],
      },
      environment: 'production/../../secret',
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ debug_id: 'not-a-debug-id', filename: codeFile }],
            },
            type: 'Error',
          },
        ],
      },
      release: 'release with user@example.com',
    });
    expect(rejected).not.toHaveProperty('debug_meta');
    expect(rejected).not.toHaveProperty('environment');
    expect(rejected).not.toHaveProperty('release');
    expect(JSON.stringify(rejected)).not.toMatch(
      /not-a-debug-id|production\/\.\.|user@example\.com/u
    );

    for (const environment of [
      'None',
      'a'.repeat(65),
      'preview/query',
      'preview environment',
      'sk-abcdefghi',
    ]) {
      expect(sanitizeSentryEvent({ environment })).not.toHaveProperty(
        'environment'
      );
    }
    for (const release of [
      '.',
      '..',
      'a'.repeat(201),
      'release/path',
      'release\\path',
      'release\nvalue',
      'sk-abcdefghi',
      'user@example.com',
      `a@${'1'.repeat(199)}`,
    ]) {
      expect(sanitizeSentryEvent({ release })).not.toHaveProperty('release');
    }
    expect(
      sanitizeSentryEvent({ release: 'start-ui-web@v5.0.0-alpha.1+7308e9c2' })
    ).toHaveProperty('release', 'start-ui-web@v5.0.0-alpha.1+7308e9c2');
  });

  it('retains at most 50 unique source-map identities', async () => {
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');
    const codeFile = 'https://cdn.example/assets/app.js';
    const debugId = (index: number) =>
      `00000000-0000-0000-0000-${index.toString(16).padStart(12, '0')}`;

    const sanitized = sanitizeSentryEvent({
      debug_meta: {
        images: Array.from({ length: 51 }, (_, index) => ({
          code_file: codeFile,
          debug_id: debugId(index),
          type: 'sourcemap',
        })),
      },
      exception: {
        values: [
          {
            stacktrace: { frames: [{ filename: codeFile }] },
            type: 'Error',
          },
        ],
      },
    }) as { debug_meta?: { images?: Array<{ debug_id: string }> } };

    expect(sanitized.debug_meta?.images).toHaveLength(50);
    expect(sanitized.debug_meta?.images?.at(-1)?.debug_id).toBe(debugId(49));
    expect(sanitized.debug_meta?.images).not.toContainEqual(
      expect.objectContaining({ debug_id: debugId(50) })
    );
  });

  it('scans at most 1,000 source-map records', async () => {
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');
    const acceptedPath = 'https://cdn.example/assets/accepted.js';
    const excludedPath = 'https://cdn.example/assets/excluded.js';
    const acceptedId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const excludedId = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const unmatched = Array.from({ length: 999 }, (_, index) => ({
      code_file: `https://cdn.example/assets/unmatched-${index}.js`,
      debug_id: `00000000-0000-0000-0000-${index
        .toString(16)
        .padStart(12, '0')}`,
      type: 'sourcemap',
    }));

    const sanitized = sanitizeSentryEvent({
      debug_meta: {
        images: [
          ...unmatched,
          {
            code_file: acceptedPath,
            debug_id: acceptedId,
            type: 'sourcemap',
          },
          {
            code_file: excludedPath,
            debug_id: excludedId,
            type: 'sourcemap',
          },
        ],
      },
      exception: {
        values: [
          {
            stacktrace: {
              frames: [{ filename: acceptedPath }, { filename: excludedPath }],
            },
            type: 'Error',
          },
        ],
      },
    });

    expect(sanitized).toHaveProperty('debug_meta.images', [
      {
        code_file: '/assets/accepted.js',
        debug_id: acceptedId,
        type: 'sourcemap',
      },
    ]);
    expect(JSON.stringify(sanitized)).not.toContain(excludedId);
  });

  it('never exports dynamic request path segments', async () => {
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');

    const sanitized = sanitizeSentryEvent({
      request: {
        method: 'GET',
        url: 'https://app.example/manager/users/person@example.com/reset/query-secret',
      },
    });

    expect(sanitized).toEqual({ request: { method: 'GET' } });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /person@example\.com|query-secret|manager\/users/u
    );
  });

  it('drops transaction query data and malformed trace correlation IDs', async () => {
    const { createSentryTelemetryAdapter, sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');
    const captureException = vi.fn(() => 'event-id');
    const adapter = createSentryTelemetryAdapter(
      {
        captureException,
        setUser: vi.fn(),
      },
      {
        currentCorrelation: () => ({
          spanId: 'span-secret',
          traceId: 'trace-secret',
        }),
      }
    );

    adapter.captureException(new Error('failed'));

    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: undefined })
    );
    expect(
      sanitizeSentryEvent({
        contexts: {
          trace: { span_id: 'span-secret', trace_id: 'trace-secret' },
        },
        transaction: 'GET /reset?token=query-secret',
      })
    ).toEqual({});
  });

  it('returns a safe event when hostile event inspection fails', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');
    const hostile = new Proxy(
      { message: 'Bearer hostile-secret' },
      {
        ownKeys: () => {
          throw new Error('inspection failed');
        },
      }
    );

    expect(() => sanitizeSentryEvent(hostile)).not.toThrow();
    expect(sanitizeSentryEvent(hostile)).toEqual({
      message: 'Unexpected application error',
    });
  });

  it('drops unsupported and non-allowlisted Sentry event tags', async () => {
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');

    expect(
      sanitizeSentryEvent({
        tags: {
          empty: '',
          nested: { value: 'object' },
          nullable: null,
          optional: undefined,
          sequence: ['array'],
          zero: 0,
          event: 'application.failed',
        },
      })
    ).toEqual({
      tags: {
        event: 'application.failed',
      },
    });
  });

  it('preserves the specific Sentry event subtype when sanitizing', async () => {
    const { sanitizeSentryEvent } =
      await import('@/composition/telemetry/sentry-adapter');
    type SpecificSentryEvent = {
      contexts?: Record<string, unknown>;
      event_id: string;
      extra?: Record<string, unknown>;
      tags?: Record<string, unknown>;
      type: 'transaction';
    };
    const event: SpecificSentryEvent = {
      event_id: 'event-1',
      extra: {
        authorization: 'Bearer token',
      },
      tags: {
        event: 'auth.failure',
      },
      type: 'transaction',
    };

    const sanitized: SpecificSentryEvent = sanitizeSentryEvent(event);

    expect(sanitized).toEqual({
      event_id: 'event-1',
      tags: {
        event: 'auth.failure',
      },
      type: 'transaction',
    });
  });

  it('clears Sentry user tags when the telemetry user is unset', async () => {
    const { createSentryTelemetryAdapter } =
      await import('@/composition/telemetry/sentry-adapter');
    const setUser = vi.fn();
    const setTag = vi.fn();
    const adapter = createSentryTelemetryAdapter({
      captureException: vi.fn(() => 'event-id'),
      setUser,
      setTag,
      startSpan: vi.fn((_options, fn) => fn()),
    });

    adapter.setUser(null);

    expect(setUser).toHaveBeenCalledWith(null);
    expect(setTag).toHaveBeenCalledWith('role', 'none');
  });
});
