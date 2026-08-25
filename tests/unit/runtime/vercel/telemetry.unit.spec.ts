import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNoOpTelemetry } from '@/platform/telemetry';

const mocks = vi.hoisted(() => ({
  createOpenTelemetryAdapter: vi.fn(),
  installServerTelemetry: vi.fn(),
  registerOTel: vi.fn(),
  reportTelemetryFailure: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  setUser: vi.fn(),
}));
vi.mock('@vercel/otel', () => ({ registerOTel: mocks.registerOTel }));
vi.mock('@/composition/telemetry/otel-adapter', () => ({
  createOpenTelemetryAdapter: mocks.createOpenTelemetryAdapter,
}));
vi.mock('@/composition/telemetry/sentry.server', () => ({
  installServerTelemetry: mocks.installServerTelemetry,
}));
vi.mock('@/modules/kernel/backend', () => ({
  getTelemetryConfig: () => ({
    collectorBearerToken: undefined,
    collectorUrl: undefined,
    dsn: undefined,
    otelEnvironment: 'tests',
    otelTracesSampleRate: 1,
    serviceName: 'test-service',
    serviceVersion: undefined,
  }),
}));
vi.mock('@/platform/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/telemetry')>()),
  reportTelemetryFailure: mocks.reportTelemetryFailure,
}));

describe('Vercel telemetry owner', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.createOpenTelemetryAdapter.mockReturnValue(createNoOpTelemetry());
  });

  it('lets @vercel/otel own traces and installs the app adapter once', async () => {
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    initVercelTelemetry();
    initVercelTelemetry();

    expect(mocks.registerOTel).toHaveBeenCalledOnce();
    expect(mocks.registerOTel).toHaveBeenCalledWith(
      expect.objectContaining({
        instrumentations: [],
        serviceName: 'test-service',
        traceExporter: 'auto',
      })
    );
    expect(mocks.createOpenTelemetryAdapter).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledOnce();
  });

  it('degrades to optional no-op behavior if the trace owner fails', async () => {
    mocks.registerOTel.mockImplementationOnce(() => {
      throw new Error('trace owner unavailable');
    });
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).not.toThrow();

    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'otel.vercel.traces.initialize',
      expect.any(Error)
    );
    expect(mocks.createOpenTelemetryAdapter).not.toHaveBeenCalled();
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: undefined,
      sentry: undefined,
    });
  });
});
