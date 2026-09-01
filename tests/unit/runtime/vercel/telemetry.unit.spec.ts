import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createNoOpTelemetry } from '@/platform/telemetry';

const mocks = vi.hoisted(() => ({
  config: {
    collectorBearerToken: undefined as string | undefined,
    collectorUrl: undefined as string | undefined,
    dsn: undefined as string | undefined,
    mode: 'optional' as 'off' | 'optional' | 'required',
    otelEnvironment: 'tests',
    otelSdkDisabled: false,
    otelTracesSampleRate: 1,
    requiredSignals: [] as Array<'exceptions' | 'logs' | 'metrics' | 'traces'>,
    serviceName: 'test-service',
    serviceVersion: undefined as string | undefined,
  },
  claimSentryNodeRequestContext: vi.fn(),
  createOpenTelemetryAdapter: vi.fn(),
  createSentryNodeRequestContextManager: vi.fn(),
  installServerTelemetry: vi.fn(),
  isServerSentryInstrumentationReady: vi.fn(),
  isSentryNodeRequestContextActive: vi.fn(),
  registerOTel: vi.fn(),
  claimTelemetryProviderOwnership: vi.fn(),
  cleanupTelemetryProviders: vi.fn(() => Promise.resolve('cleaned')),
  releaseSignalOwnership: vi.fn(),
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
vi.mock('@/composition/telemetry/provider-cleanup', () => ({
  cleanupTelemetryProviders: mocks.cleanupTelemetryProviders,
}));
vi.mock('@/composition/telemetry/provider-ownership', () => ({
  claimTelemetryProviderOwnership: mocks.claimTelemetryProviderOwnership,
}));
vi.mock('@/composition/telemetry/sentry.server', () => ({
  installServerTelemetry: mocks.installServerTelemetry,
}));
vi.mock('@/modules/kernel/backend', async () => ({
  ...(await import('@/modules/kernel/infrastructure/config/telemetry-readiness')),
  getTelemetryConfig: () => mocks.config,
  ...(await import('@/modules/kernel/infrastructure/config/otel-sdk-environment')),
}));
vi.mock('@/platform/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/telemetry')>()),
  isServerSentryInstrumentationReady: mocks.isServerSentryInstrumentationReady,
  reportTelemetryFailure: mocks.reportTelemetryFailure,
}));

describe('Vercel telemetry owner', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.config.collectorUrl = undefined;
    mocks.config.dsn = undefined;
    mocks.config.mode = 'optional';
    mocks.config.otelSdkDisabled = false;
    mocks.config.requiredSignals = [];
    mocks.createOpenTelemetryAdapter.mockReturnValue(createNoOpTelemetry());
    mocks.createSentryNodeRequestContextManager.mockReturnValue(
      mocks.requestContextManager
    );
    mocks.claimSentryNodeRequestContext.mockReturnValue(mocks.requestContext);
    mocks.isSentryNodeRequestContextActive.mockReturnValue(true);
    mocks.isServerSentryInstrumentationReady.mockReturnValue(true);
    mocks.claimTelemetryProviderOwnership.mockReturnValue(
      mocks.releaseSignalOwnership
    );
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
    expect(mocks.requestContext.release).toHaveBeenCalledOnce();
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
    mocks.config.mode = 'off';
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

  it('releases off-mode request isolation when Sentry is not configured', async () => {
    mocks.config.mode = 'off';
    mocks.config.otelSdkDisabled = true;
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    initVercelTelemetry();

    expect(mocks.claimSentryNodeRequestContext).toHaveBeenCalledWith(
      mocks.requestContextManager
    );
    expect(mocks.requestContext.release).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: undefined,
      sentry: undefined,
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

  it('omits optional Sentry when instrumentation is unavailable', async () => {
    mocks.config.dsn = 'https://public@example.invalid/1';
    mocks.isServerSentryInstrumentationReady.mockReturnValueOnce(false);
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).not.toThrow();
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: expect.any(Object),
      sentry: undefined,
    });
  });

  it('degrades and releases signal owners when adapter creation fails', async () => {
    mocks.config.collectorUrl = 'https://collector.example.invalid';
    mocks.createOpenTelemetryAdapter.mockImplementationOnce(() => {
      throw new Error('adapter unavailable');
    });
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).not.toThrow();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'otel.vercel.adapter.initialize',
      expect.any(Error)
    );
    expect(mocks.releaseSignalOwnership).toHaveBeenCalledOnce();
    expect(mocks.cleanupTelemetryProviders).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: undefined,
      sentry: undefined,
    });
  });

  it('caches a required adapter failure without cleaning signal owners twice', async () => {
    mocks.config.collectorUrl = 'https://collector.example.invalid';
    mocks.config.mode = 'required';
    mocks.config.requiredSignals = ['logs', 'metrics'];
    mocks.createOpenTelemetryAdapter.mockImplementationOnce(() => {
      throw new Error('adapter unavailable');
    });
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).toThrow(
      'vercel during initialization: metrics, logs'
    );
    expect(() => initVercelTelemetry()).toThrow(
      'vercel during initialization: metrics, logs'
    );
    expect(mocks.releaseSignalOwnership).toHaveBeenCalledOnce();
    expect(mocks.cleanupTelemetryProviders).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).not.toHaveBeenCalled();
  });

  it('fails and caches required trace-owner initialization', async () => {
    mocks.config.mode = 'required';
    mocks.config.requiredSignals = ['traces'];
    mocks.registerOTel.mockImplementationOnce(() => {
      throw new Error('trace owner unavailable');
    });
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).toThrow(
      'vercel during initialization: traces'
    );
    expect(() => initVercelTelemetry()).toThrow(
      'vercel during initialization: traces'
    );
    expect(mocks.registerOTel).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).not.toHaveBeenCalled();
    expect(mocks.requestContext.release).toHaveBeenCalledOnce();
  });

  it('fails required collector-signal initialization', async () => {
    mocks.config.collectorUrl = 'https://collector.example.invalid';
    mocks.config.mode = 'required';
    mocks.config.requiredSignals = ['logs', 'metrics'];
    mocks.claimTelemetryProviderOwnership.mockImplementationOnce(() => {
      throw new Error('signal owners unavailable');
    });
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).toThrow(
      'vercel during initialization: metrics, logs'
    );
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'otel.vercel.signals.initialize',
      expect.any(Error)
    );
    expect(mocks.cleanupTelemetryProviders).toHaveBeenCalledOnce();
  });

  it('fails required exceptions when instrumentation is unavailable', async () => {
    mocks.config.collectorUrl = 'https://collector.example.invalid';
    mocks.config.dsn = 'https://public@example.invalid/1';
    mocks.config.mode = 'required';
    mocks.config.requiredSignals = ['exceptions'];
    mocks.isServerSentryInstrumentationReady.mockReturnValueOnce(false);
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).toThrow(
      'vercel during initialization: exceptions'
    );
    expect(mocks.installServerTelemetry).not.toHaveBeenCalled();
    expect(mocks.releaseSignalOwnership).toHaveBeenCalledOnce();
    expect(mocks.cleanupTelemetryProviders).toHaveBeenCalledOnce();
  });

  it('caches even an undefined initialization failure', async () => {
    mocks.installServerTelemetry.mockImplementationOnce(() => {
      // JavaScript dependencies can throw any value at this boundary.
      // oxlint-disable-next-line no-throw-literal
      throw undefined;
    });
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    const failures: unknown[] = [];
    for (const initialize of [initVercelTelemetry, initVercelTelemetry]) {
      try {
        initialize();
      } catch (failure) {
        failures.push(failure);
      }
    }

    expect(failures).toEqual([undefined, undefined]);
    expect(mocks.registerOTel).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledOnce();
  });

  it('starts when every required Vercel owner is ready', async () => {
    mocks.config.collectorUrl = 'https://collector.example.invalid';
    mocks.config.dsn = 'https://public@example.invalid/1';
    mocks.config.mode = 'required';
    mocks.config.requiredSignals = ['traces', 'metrics', 'logs', 'exceptions'];
    const { initVercelTelemetry } = await import('@/runtime/vercel/telemetry');

    expect(() => initVercelTelemetry()).not.toThrow();
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: expect.any(Object),
      sentry: expect.any(Object),
    });
  });
});
