import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createNoOpTelemetry,
  getTelemetry,
  setTelemetry,
} from '@/platform/telemetry';
import { configureCloudflareRequestTelemetry } from '@/runtime/cloudflare/request-telemetry';

const createTracing = () => {
  const span = {
    end: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
  };
  span.setAttribute.mockReturnValue(span);
  span.setAttributes.mockReturnValue(span);
  return {
    enterSpan: vi.fn((_name, callback) => callback(span)),
    startActiveSpan: vi.fn((_name, callback) => callback(span)),
    startSpan: vi.fn(() => span),
  };
};

const createSentry = () => ({
  captureException: vi.fn(),
  eventFiltersIntegration: vi.fn(() => ({ name: 'EventFilters' })),
  linkedErrorsIntegration: vi.fn(() => ({ name: 'LinkedErrors' })),
  setTag: vi.fn(),
  setUser: vi.fn(),
  startSpan: vi.fn((_options, operation) => operation()),
});

const request = new Request('https://app.example.test/account');

describe('Cloudflare request telemetry configuration', () => {
  beforeEach(() => {
    setTelemetry(createNoOpTelemetry());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps Sentry exceptions available while off mode skips native OTel', () => {
    const hostileTracing = Object.defineProperty({}, 'enterSpan', {
      get: () => {
        throw new Error('native tracing must not be inspected');
      },
    });
    const result = configureCloudflareRequestTelemetry({
      environment: {
        SENTRY_DSN: 'https://public@example.com/1',
        TELEMETRY_MODE: 'off',
      },
      request,
      sentry: createSentry() as never,
      sentryRequestIsolationReady: true,
      tracing: hostileTracing,
    });

    expect(result.sentryOptions).toBeDefined();
    expect(result.requireSentryOwner).toBe(false);
    expect(getTelemetry()).not.toBe(result.telemetry);
  });

  it('does not inspect native or unrelated bindings in off mode', () => {
    const analyticsGetter = vi.fn(() => {
      throw new Error('analytics binding must not be inspected');
    });
    const unrelatedGetter = vi.fn(() => {
      throw new Error('unrelated binding must not be inspected');
    });
    const analytics = Object.defineProperty({}, 'writeDataPoint', {
      get: analyticsGetter,
    });
    const environment = Object.defineProperties(
      { TELEMETRY_MODE: 'off' },
      {
        START_UI_TELEMETRY_METRICS: { value: analytics },
        UNRELATED_BINDING: { get: unrelatedGetter },
      }
    );

    expect(() =>
      configureCloudflareRequestTelemetry({
        environment,
        request,
        sentry: createSentry() as never,
        sentryRequestIsolationReady: true,
        tracing: {},
      })
    ).not.toThrow();
    expect(analyticsGetter).not.toHaveBeenCalled();
    expect(unrelatedGetter).not.toHaveBeenCalled();
  });

  it('degrades optional native capability failures with one bounded diagnostic', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const previousTelemetry = getTelemetry();
    const result = configureCloudflareRequestTelemetry({
      environment: {},
      request,
      sentry: createSentry() as never,
      sentryRequestIsolationReady: true,
      tracing: {},
    });
    const second = configureCloudflareRequestTelemetry({
      environment: {},
      request,
      sentry: createSentry() as never,
      sentryRequestIsolationReady: true,
      tracing: {},
    });

    expect(result.sentryOptions).toBeUndefined();
    expect(result.telemetry).not.toBe(previousTelemetry);
    expect(second.telemetry).not.toBe(result.telemetry);
    expect(getTelemetry()).toBe(previousTelemetry);
    expect(consoleError).toHaveBeenCalledTimes(2);
    expect(
      consoleError.mock.calls
        .map(([, detail]) => String((detail as { source?: unknown }).source))
        .toSorted((left, right) => left.localeCompare(right, 'en'))
    ).toEqual([
      'otel.cloudflare.metrics.unavailable',
      'otel.cloudflare.traces.unavailable',
    ]);
  });

  it('fails required traces before resolving a request adapter', () => {
    const previousTelemetry = getTelemetry();

    expect(() =>
      configureCloudflareRequestTelemetry({
        environment: {
          TELEMETRY_MODE: 'required',
          TELEMETRY_REQUIRED_SIGNALS: 'traces',
        },
        request,
        sentry: createSentry() as never,
        sentryRequestIsolationReady: true,
        tracing: {},
      })
    ).toThrow('cloudflare during request: traces');
    expect(getTelemetry()).toBe(previousTelemetry);
  });

  it('fails required metrics without the current Analytics Engine binding', () => {
    expect(() =>
      configureCloudflareRequestTelemetry({
        environment: {
          TELEMETRY_MODE: 'required',
          TELEMETRY_REQUIRED_SIGNALS: 'metrics',
        },
        request,
        sentry: createSentry() as never,
        sentryRequestIsolationReady: true,
        tracing: createTracing() as never,
      })
    ).toThrow('cloudflare during request: metrics');
  });

  it.each(['logs', 'metrics'] as const)(
    'keeps required %s ready when only tracing is unavailable',
    (signal) => {
      const analytics = { writeDataPoint: vi.fn() };
      const result = configureCloudflareRequestTelemetry({
        environment: {
          START_UI_TELEMETRY_METRICS: analytics,
          TELEMETRY_MODE: 'required',
          TELEMETRY_REQUIRED_SIGNALS: signal,
        },
        request,
        sentry: createSentry() as never,
        sentryRequestIsolationReady: true,
        tracing: {},
      });

      expect(() =>
        result.telemetry.emitLog({ event: 'worker.ready', level: 'info' })
      ).not.toThrow();
      result.telemetry.recordMetric({
        name: 'app.http.request.duration',
        value: 12,
      });
      expect(analytics.writeDataPoint).toHaveBeenCalledOnce();
    }
  );

  it.each([
    [{}, true],
    [{ SENTRY_DSN: 'https://public@example.com/1' }, false],
  ] as const)(
    'fails required exceptions when request isolation is unavailable',
    (environment, sentryRequestIsolationReady) => {
      expect(() =>
        configureCloudflareRequestTelemetry({
          environment: {
            ...environment,
            TELEMETRY_MODE: 'required',
            TELEMETRY_REQUIRED_SIGNALS: 'exceptions',
          },
          request,
          sentry: createSentry() as never,
          sentryRequestIsolationReady,
          tracing: createTracing() as never,
        })
      ).toThrow('cloudflare during request: exceptions');
    }
  );

  it('fails required exceptions when integration construction fails', () => {
    const sentry = createSentry();
    sentry.eventFiltersIntegration.mockImplementationOnce(() => {
      throw new Error('integration unavailable');
    });

    expect(() =>
      configureCloudflareRequestTelemetry({
        environment: {
          SENTRY_DSN: 'https://public@example.com/1',
          TELEMETRY_MODE: 'required',
          TELEMETRY_REQUIRED_SIGNALS: 'exceptions',
        },
        request,
        sentry: sentry as never,
        sentryRequestIsolationReady: true,
        tracing: createTracing() as never,
      })
    ).toThrow('cloudflare during request: exceptions');
  });

  it('starts when every required Worker request owner is ready', () => {
    const analytics = { writeDataPoint: vi.fn() };
    const result = configureCloudflareRequestTelemetry({
      environment: {
        SENTRY_DSN: 'https://public@example.com/1',
        START_UI_TELEMETRY_METRICS: analytics,
        TELEMETRY_MODE: 'required',
        TELEMETRY_REQUIRED_SIGNALS: 'exceptions,logs,metrics,traces',
      },
      request,
      sentry: createSentry() as never,
      sentryRequestIsolationReady: true,
      tracing: createTracing() as never,
    });

    expect(result.requireSentryOwner).toBe(true);
    expect(result.sentryOptions).toBeDefined();
    expect(getTelemetry()).not.toBe(result.telemetry);
  });

  it('never reuses a previous request adapter for a degraded later request', () => {
    const analytics = { writeDataPoint: vi.fn() };
    const first = configureCloudflareRequestTelemetry({
      environment: { START_UI_TELEMETRY_METRICS: analytics },
      request,
      sentry: createSentry() as never,
      sentryRequestIsolationReady: true,
      tracing: createTracing() as never,
    });
    const second = configureCloudflareRequestTelemetry({
      environment: {},
      request,
      sentry: createSentry() as never,
      sentryRequestIsolationReady: true,
      tracing: {},
    });

    expect(second.telemetry).not.toBe(first.telemetry);
    second.telemetry.recordMetric({
      name: 'app.http.request.duration',
      value: 12,
    });
    expect(analytics.writeDataPoint).not.toHaveBeenCalled();
  });
});
