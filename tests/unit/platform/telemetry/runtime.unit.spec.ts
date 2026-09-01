import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createNoOpTelemetry,
  setTelemetry,
  telemetryProxy,
  type TelemetryAdapter,
} from '@/platform/telemetry';

afterEach(() => {
  setTelemetry(createNoOpTelemetry());
  vi.restoreAllMocks();
});

describe('telemetryProxy', () => {
  it('isolates report-only, correlation, and manual-span creation failures', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const fail = () => {
      throw new Error('provider failed');
    };
    setTelemetry({
      ...createNoOpTelemetry(),
      captureException: fail,
      currentCorrelation: fail,
      emitLog: fail,
      forceFlush: () => Promise.reject(new Error('flush failed')),
      recordMetric: fail,
      setUser: fail,
      startManualSpan: fail,
    });

    expect(() =>
      telemetryProxy.captureException(new Error('app failed'))
    ).not.toThrow();
    expect(() =>
      telemetryProxy.emitLog({ event: 'app.failed', level: 'error' })
    ).not.toThrow();
    expect(() =>
      telemetryProxy.recordMetric({ name: 'app.request', value: 1 })
    ).not.toThrow();
    expect(() => telemetryProxy.setUser({ id: 'user-1' })).not.toThrow();
    expect(telemetryProxy.currentCorrelation()).toEqual({});
    const span = telemetryProxy.startManualSpan({ name: 'safe.span' });
    expect(() => span.setStatus('error')).not.toThrow();
  });

  it('does not swallow application errors thrown inside traced work', () => {
    const applicationError = new Error('application failed');

    expect(() =>
      telemetryProxy.startSpan({ name: 'application.work' }, () => {
        throw applicationError;
      })
    ).toThrow(applicationError);
  });

  it('does not hide separate capture calls behind process-global state', () => {
    const captureException = vi.fn();
    setTelemetry({
      ...createNoOpTelemetry(),
      captureException,
    });
    const error = new Error('application failed');

    telemetryProxy.captureException(error, {
      tags: { event: 'procedure.failed', requestId: 'request-1' },
    });
    telemetryProxy.captureException(error, {
      tags: { event: 'framework.request.failed', requestId: 'request-1' },
    });
    telemetryProxy.captureException(error, {
      tags: { event: 'framework.request.failed', requestId: 'request-2' },
    });

    expect(captureException).toHaveBeenCalledTimes(3);
    expect(captureException).toHaveBeenNthCalledWith(1, error, {
      tags: { event: 'procedure.failed', requestId: 'request-1' },
    });
    expect(captureException).toHaveBeenNthCalledWith(2, error, {
      tags: { event: 'framework.request.failed', requestId: 'request-1' },
    });
    expect(captureException).toHaveBeenNthCalledWith(3, error, {
      tags: { event: 'framework.request.failed', requestId: 'request-2' },
    });
  });

  it('runs work once and preserves its result when span orchestration fails', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const syncWork = vi.fn(() => 'sync-result');
    setTelemetry({
      ...createNoOpTelemetry(),
      startSpan: (_options, work) => {
        work();
        throw new Error('span completion failed');
      },
    });

    expect(telemetryProxy.startSpan({ name: 'sync.work' }, syncWork)).toBe(
      'sync-result'
    );
    expect(syncWork).toHaveBeenCalledOnce();

    const asyncWork = vi.fn(() => Promise.resolve('async-result'));
    setTelemetry({
      ...createNoOpTelemetry(),
      startSpan: ((_options, work) =>
        Promise.resolve(work()).then(() => {
          throw new Error('async span completion failed');
        })) as TelemetryAdapter['startSpan'],
    });

    await expect(
      telemetryProxy.startSpan({ name: 'async.work' }, asyncWork)
    ).resolves.toBe('async-result');
    expect(asyncWork).toHaveBeenCalledOnce();
  });

  it('preserves asynchronous application rejections', async () => {
    const applicationError = new Error('async application failed');

    await expect(
      telemetryProxy.startSpan({ name: 'async.application' }, () =>
        Promise.reject(applicationError)
      )
    ).rejects.toBe(applicationError);
  });

  it('always returns the application result when an adapter substitutes a value', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    setTelemetry({
      ...createNoOpTelemetry(),
      startSpan: ((_options, work) => {
        work();
        return 'provider-value';
      }) as TelemetryAdapter['startSpan'],
    });

    expect(
      telemetryProxy.startSpan({ name: 'sync.application' }, () => 'app-value')
    ).toBe('app-value');

    const applicationPromise = Promise.reject(new Error('app rejected'));
    applicationPromise.catch(() => undefined);
    setTelemetry({
      ...createNoOpTelemetry(),
      startSpan: ((_options, work) => {
        void work();
        return Promise.resolve('provider-value');
      }) as TelemetryAdapter['startSpan'],
    });

    await expect(
      telemetryProxy.startSpan(
        { name: 'async.application' },
        () => applicationPromise
      )
    ).rejects.toThrow('app rejected');
  });

  it('preserves the application result when a provider returns a hostile thenable', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const hostileProviderResult = Object.defineProperty(
      {},
      // oxlint-disable-next-line unicorn/no-thenable -- Regression fixture for a hostile provider return value.
      'then',
      {
        get: () => {
          throw new Error('provider then getter failed');
        },
      }
    );
    setTelemetry({
      ...createNoOpTelemetry(),
      startSpan: ((_options, work) => {
        work();
        return hostileProviderResult;
      }) as TelemetryAdapter['startSpan'],
    });

    expect(
      telemetryProxy.startSpan({ name: 'sync.application' }, () => 'app-value')
    ).toBe('app-value');
    expect(globalThis.console.error).toHaveBeenCalledWith(
      'telemetry.report_failure',
      expect.objectContaining({ source: 'telemetry.inspect_thenable' })
    );
  });

  it('memoizes work when an adapter skips, defers, or duplicates its callback', async () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    let deferredWork: (() => unknown) | undefined;
    const work = vi.fn(() => 'application-value');
    setTelemetry({
      ...createNoOpTelemetry(),
      startSpan: ((_options, callback) => {
        deferredWork = callback;
        return Promise.reject(new Error('provider rejected'));
      }) as TelemetryAdapter['startSpan'],
    });

    expect(telemetryProxy.startSpan({ name: 'deferred.work' }, work)).toBe(
      'application-value'
    );
    expect(deferredWork?.()).toBe('application-value');
    expect(deferredWork?.()).toBe('application-value');
    expect(work).toHaveBeenCalledOnce();
    await vi.waitFor(() => {
      expect(globalThis.console.error).toHaveBeenCalled();
    });
  });

  it('guards every manual span method after successful creation', () => {
    vi.spyOn(globalThis.console, 'error').mockImplementation(() => undefined);
    const fail = () => {
      throw new Error('manual span failed');
    };
    setTelemetry({
      ...createNoOpTelemetry(),
      startManualSpan: () => ({
        addEvent: fail,
        end: fail,
        setAttributes: fail,
        setStatus: fail,
      }),
    });

    const span = telemetryProxy.startManualSpan({ name: 'manual.span' });

    expect(() => span.addEvent('event')).not.toThrow();
    expect(() => span.setAttributes({ status: 'safe' })).not.toThrow();
    expect(() => span.setStatus('error')).not.toThrow();
    expect(() => span.end()).not.toThrow();
    expect(globalThis.console.error).toHaveBeenCalledTimes(4);
  });
});
