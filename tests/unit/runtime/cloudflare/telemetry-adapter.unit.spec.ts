import { describe, expect, it, vi } from 'vitest';

import {
  createCloudflareTelemetryAdapter,
  isCloudflareAnalyticsEngine,
  isCloudflareTracing,
} from '@/runtime/cloudflare/telemetry-adapter';

const createTracing = () => {
  const span = {
    end: vi.fn(),
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
  };
  span.setAttribute.mockImplementation(() => span);
  span.setAttributes.mockImplementation(() => span);
  return {
    span,
    tracing: {
      enterSpan: vi.fn((_name, callback) => callback(span)),
      startActiveSpan: vi.fn((_name, callback) => callback(span)),
      startSpan: vi.fn(() => span),
    },
  };
};

describe('Cloudflare native telemetry adapter', () => {
  it('validates native capability shapes without invoking provider methods', () => {
    const { tracing } = createTracing();
    const analytics = { writeDataPoint: vi.fn() };

    expect(isCloudflareTracing(tracing)).toBe(true);
    expect(isCloudflareAnalyticsEngine(analytics)).toBe(true);
    expect(tracing.enterSpan).not.toHaveBeenCalled();
    expect(tracing.startActiveSpan).not.toHaveBeenCalled();
    expect(tracing.startSpan).not.toHaveBeenCalled();
    expect(analytics.writeDataPoint).not.toHaveBeenCalled();
  });

  it('rejects missing and hostile capability shapes', () => {
    const hostile = Object.defineProperty({}, 'enterSpan', {
      get: () => {
        throw new Error('hostile getter');
      },
    });

    expect(isCloudflareTracing({})).toBe(false);
    expect(isCloudflareTracing(hostile)).toBe(false);
    expect(isCloudflareAnalyticsEngine({})).toBe(false);
    expect(isCloudflareAnalyticsEngine(undefined)).toBe(false);
  });

  it('emits a closed exception record without raw failure text', () => {
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const { tracing } = createTracing();
    const adapter = createCloudflareTelemetryAdapter({ tracing });

    adapter.captureException(new Error('secret query token=hidden'), {
      tags: { event: 'request.failed' },
    });

    expect(consoleError).toHaveBeenCalledWith('telemetry.cloudflare', {
      errorType: 'Error',
      event: 'request.failed',
      level: 'error',
    });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('hidden');
  });

  it('bridges bounded metrics to Analytics Engine synchronously', () => {
    const { tracing } = createTracing();
    const analytics = { writeDataPoint: vi.fn() };
    const adapter = createCloudflareTelemetryAdapter({ analytics, tracing });

    adapter.recordMetric({
      attributes: { 'http.request.method': 'GET', secret: 'not-exported' },
      name: 'app.http.request.duration',
      type: 'histogram',
      unit: 'ms',
      value: 12,
    });

    expect(analytics.writeDataPoint).toHaveBeenCalledWith({
      blobs: ['histogram', '{"http.request.method":"GET"}'],
      doubles: [12],
      indexes: ['app.http.request.duration'],
    });
  });

  it('uses the async-context-preserving native span contract', async () => {
    const { span, tracing } = createTracing();
    const adapter = createCloudflareTelemetryAdapter({ tracing });

    await expect(
      adapter.startSpan({ name: 'ignored', op: 'http.server' }, async () => {
        await Promise.resolve();
        return 'application-result';
      })
    ).resolves.toBe('application-result');
    expect(tracing.enterSpan).toHaveBeenCalledOnce();
    expect(tracing.startActiveSpan).not.toHaveBeenCalled();
    expect(span.end).not.toHaveBeenCalled();
  });
});
