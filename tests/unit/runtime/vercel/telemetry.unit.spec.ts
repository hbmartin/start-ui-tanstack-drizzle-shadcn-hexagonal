import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNoOpTelemetry } from '@/platform/telemetry';

const mocks = vi.hoisted(() => ({
  config: {
    collectorBearerToken: undefined as string | undefined,
    collectorUrl: undefined as string | undefined,
    dsn: undefined as string | undefined,
    otelEnvironment: 'tests',
    otelSdkDisabled: false,
    otelTracesSampleRate: 1,
    serviceName: 'test-service',
    serviceVersion: undefined as string | undefined,
  },
  claimSentryNodeRequestContext: vi.fn(),
  createOpenTelemetryAdapter: vi.fn(),
  createSentryNodeRequestContextManager: vi.fn(),
  installServerTelemetry: vi.fn(),
  isSentryNodeRequestContextActive: vi.fn(),
  registerOTel: vi.fn(),
  reportTelemetryFailure: vi.fn(),
  requestContext: {
    contextManager: { name: 'claimed-sentry-context' },
    release: vi.fn(),
  },
  requestContextManager: { name: 'sentry-context-manager' },
}));

vi.mock('@sentry/node', () => ({
  SentryContextManager: class SentryContextManager {},
  captureException: vi.fn(),
  setUser: vi.fn(),
  withIsolationScope: <T>(operation: () => T): T => operation(),
}));
vi.mock('@vercel/otel', () => ({ registerOTel: mocks.registerOTel }));
vi.mock('@/composition/telemetry/sentry-node-request-context', () => ({
  claimSentryNodeRequestContext: mocks.claimSentryNodeRequestContext,
  createSentryNodeRequestContextManager:
    mocks.createSentryNodeRequestContextManager,
  isSentryNodeRequestContextActive: mocks.isSentryNodeRequestContextActive,
  runWithSentryNodeRequestIsolation: <T>(operation: () => T): T => operation(),
}));
vi.mock('@/composition/telemetry/otel-adapter', () => ({
  createOpenTelemetryAdapter: mocks.createOpenTelemetryAdapter,
}));
vi.mock('@/composition/telemetry/sentry.server', () => ({
  installServerTelemetry: mocks.installServerTelemetry,
}));
vi.mock('@/modules/kernel/backend', async () => ({
  getTelemetryConfig: () => mocks.config,
  ...(await import('@/modules/kernel/infrastructure/config/otel-sdk-environment')),
}));
vi.mock('@/platform/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/telemetry')>()),
  reportTelemetryFailure: mocks.reportTelemetryFailure,
}));

describe('Vercel telemetry owner', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.config.collectorUrl = undefined;
    mocks.config.dsn = undefined;
    mocks.config.otelSdkDisabled = false;
    mocks.createOpenTelemetryAdapter.mockReturnValue(createNoOpTelemetry());
    mocks.createSentryNodeRequestContextManager.mockReturnValue(
      mocks.requestContextManager
    );
    mocks.claimSentryNodeRequestContext.mockReturnValue(mocks.requestContext);
    mocks.isSentryNodeRequestContextActive.mockReturnValue(true);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lets @vercel/otel own traces and installs the app adapter once', async () => {
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    initVercelTelemetry();
    initVercelTelemetry();

    expect(mocks.registerOTel).toHaveBeenCalledOnce();
    expect(mocks.registerOTel).toHaveBeenCalledWith(
      expect.objectContaining({
        contextManager: expect.any(Object),
        instrumentations: [],
        serviceName: 'test-service',
        traceExporter: 'auto',
      })
    );
    expect(mocks.createOpenTelemetryAdapter).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledOnce();
    expect(mocks.claimSentryNodeRequestContext).not.toHaveBeenCalled();
    expect(mocks.isSentryNodeRequestContextActive).toHaveBeenCalledWith(
      mocks.requestContextManager
    );
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
    expect(mocks.claimSentryNodeRequestContext).toHaveBeenCalledWith(
      mocks.requestContextManager,
      { acceptAlreadyInstalledByProvider: true }
    );
  });

  it('keeps Sentry request isolation when the trace owner fails', async () => {
    mocks.config.dsn = 'https://public@example.invalid/1';
    mocks.registerOTel.mockImplementationOnce(() => {
      throw new Error('trace owner unavailable');
    });
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).not.toThrow();

    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: undefined,
      sentry: expect.objectContaining({
        captureException: expect.any(Function),
      }),
    });
  });

  it('keeps Sentry request isolation when the standard OTel SDK is disabled', async () => {
    mocks.config.otelSdkDisabled = true;
    mocks.config.collectorUrl = 'https://collector.example.invalid';
    mocks.config.dsn = 'https://public@example.invalid/1';
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    initVercelTelemetry();

    expect(mocks.registerOTel).not.toHaveBeenCalled();
    expect(mocks.createOpenTelemetryAdapter).not.toHaveBeenCalled();
    expect(mocks.claimSentryNodeRequestContext).toHaveBeenCalledWith(
      mocks.requestContextManager
    );
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: undefined,
      sentry: expect.objectContaining({
        captureException: expect.any(Function),
      }),
    });
  });

  it('normalizes a false OTel SDK flag before Vercel bootstrap and restores it', async () => {
    vi.stubEnv('OTEL_SDK_DISABLED', 'false');
    mocks.registerOTel.mockImplementationOnce(() => {
      expect(process.env.OTEL_SDK_DISABLED).toBeUndefined();
    });
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    initVercelTelemetry();

    expect(mocks.registerOTel).toHaveBeenCalledOnce();
    expect(process.env.OTEL_SDK_DISABLED).toBe('false');
  });

  it('disables Sentry capture if request isolation cannot be established', async () => {
    mocks.config.dsn = 'https://public@example.invalid/1';
    mocks.createSentryNodeRequestContextManager.mockReturnValueOnce(undefined);
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    initVercelTelemetry();

    expect(mocks.registerOTel).toHaveBeenCalledWith(
      expect.not.objectContaining({ contextManager: expect.anything() })
    );
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: expect.any(Object),
      sentry: undefined,
    });
  });

  it('disables Sentry if Vercel starts with an unrelated context owner', async () => {
    mocks.config.dsn = 'https://public@example.invalid/1';
    mocks.isSentryNodeRequestContextActive.mockReturnValueOnce(false);
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    initVercelTelemetry();

    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: expect.any(Object),
      sentry: undefined,
    });
  });
});
