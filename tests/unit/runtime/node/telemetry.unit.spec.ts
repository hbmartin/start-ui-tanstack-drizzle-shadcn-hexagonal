import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNoOpTelemetry } from '@/platform/telemetry';

const mocks = vi.hoisted(() => ({
  config: {
    collectorUrl: undefined as string | undefined,
    dsn: 'https://public@example.invalid/1' as string | undefined,
    mode: 'off' as 'off' | 'optional' | 'required',
    otelSdkDisabled: true,
    requiredSignals: [] as Array<'exceptions' | 'logs' | 'metrics' | 'traces'>,
  },
  initOpenTelemetryServer: vi.fn(),
  initializeSentryNodeRequestContext: vi.fn(),
  installPersistentTelemetryLifecycle: vi.fn(),
  installServerTelemetry: vi.fn(),
  isServerSentryInstrumentationReady: vi.fn(),
  releaseRequestContext: vi.fn(),
  reportTelemetryFailure: vi.fn(),
  setLocalTelemetrySummaryRecorder: vi.fn(),
  shutdownProvider: vi.fn(),
}));

vi.mock('@sentry/node', () => ({
  captureException: vi.fn(),
  setUser: vi.fn(),
  withIsolationScope: <T>(operation: () => T): T => operation(),
}));
vi.mock('@/composition/telemetry/otel.server', () => ({
  initOpenTelemetryServer: mocks.initOpenTelemetryServer,
}));
vi.mock('@/composition/telemetry/local-sqlite-sink', () => ({
  persistLocalTelemetrySummary: vi.fn(),
}));
vi.mock('@/composition/telemetry/local-summary', () => ({
  setLocalTelemetrySummaryRecorder: mocks.setLocalTelemetrySummaryRecorder,
}));
vi.mock('@/composition/telemetry/sentry-node-request-context', () => ({
  initializeSentryNodeRequestContext: mocks.initializeSentryNodeRequestContext,
  runWithSentryNodeRequestIsolation: <T>(operation: () => T): T => operation(),
}));
vi.mock('@/composition/telemetry/sentry.server', () => ({
  installServerTelemetry: mocks.installServerTelemetry,
}));
vi.mock('@/modules/kernel/backend', async () => ({
  ...(await import('@/modules/kernel/infrastructure/config/telemetry-readiness')),
  getTelemetryConfig: () => mocks.config,
}));
vi.mock('@/platform/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/telemetry')>()),
  isServerSentryInstrumentationReady: mocks.isServerSentryInstrumentationReady,
  reportTelemetryFailure: mocks.reportTelemetryFailure,
}));
vi.mock('@/runtime/node/process-lifecycle', () => ({
  createPersistentTelemetryRuntime: vi.fn(() => undefined),
  installPersistentTelemetryLifecycle:
    mocks.installPersistentTelemetryLifecycle,
}));

describe('Node telemetry owner', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.config.dsn = 'https://public@example.invalid/1';
    mocks.config.mode = 'off';
    mocks.config.otelSdkDisabled = true;
    mocks.config.requiredSignals = [];
    mocks.initOpenTelemetryServer.mockReturnValue({
      adapter: createNoOpTelemetry(),
      shutdown: mocks.shutdownProvider,
    });
    mocks.initializeSentryNodeRequestContext.mockReturnValue({
      contextManager: {},
      release: mocks.releaseRequestContext,
    });
    mocks.isServerSentryInstrumentationReady.mockReturnValue(true);
    mocks.installServerTelemetry.mockReturnValue(createNoOpTelemetry());
  });

  it('keeps Sentry isolation but skips every app-owned OTel provider when disabled', async () => {
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await initNodeTelemetry();

    expect(mocks.initOpenTelemetryServer).not.toHaveBeenCalled();
    expect(mocks.initializeSentryNodeRequestContext).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: undefined,
      sentry: expect.objectContaining({
        captureException: expect.any(Function),
      }),
    });
    expect(mocks.setLocalTelemetrySummaryRecorder).not.toHaveBeenCalled();
  });

  it('initializes app-owned OTel when the standard disable flag is false', async () => {
    mocks.config.mode = 'optional';
    mocks.config.otelSdkDisabled = false;
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await initNodeTelemetry();

    expect(mocks.initOpenTelemetryServer).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: expect.any(Object),
      sentry: expect.any(Object),
    });
  });

  it('does not install OTel providers without a functional async context owner', async () => {
    mocks.config.mode = 'optional';
    mocks.config.otelSdkDisabled = false;
    mocks.initializeSentryNodeRequestContext.mockReturnValueOnce(undefined);
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await initNodeTelemetry();

    expect(mocks.initOpenTelemetryServer).not.toHaveBeenCalled();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'otel.node.context_unavailable',
      expect.any(Error)
    );
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: undefined,
      sentry: undefined,
    });
  });

  it('degrades when optional request-context initialization rejects', async () => {
    const contextFailure = new Error('context unavailable');
    mocks.config.mode = 'optional';
    mocks.config.otelSdkDisabled = false;
    mocks.initializeSentryNodeRequestContext.mockRejectedValueOnce(
      contextFailure
    );
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await expect(initNodeTelemetry()).resolves.toBeUndefined();
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'sentry.node.context_initialize',
      contextFailure
    );
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: undefined,
      sentry: undefined,
    });
  });

  it('fails when required request-context initialization rejects', async () => {
    mocks.config.mode = 'required';
    mocks.config.otelSdkDisabled = false;
    mocks.config.requiredSignals = ['exceptions'];
    mocks.initializeSentryNodeRequestContext.mockRejectedValueOnce(
      new Error('context unavailable')
    );
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await expect(initNodeTelemetry()).rejects.toThrow(
      'node during initialization: exceptions'
    );
    expect(mocks.installServerTelemetry).not.toHaveBeenCalled();
  });

  it('keeps optional OTel but omits Sentry when instrumentation is unavailable', async () => {
    mocks.config.mode = 'optional';
    mocks.config.otelSdkDisabled = false;
    mocks.isServerSentryInstrumentationReady.mockReturnValueOnce(false);
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await initNodeTelemetry();

    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: expect.any(Object),
      sentry: undefined,
    });
  });

  it('shares one initialization across concurrent bootstrap callers', async () => {
    mocks.config.mode = 'optional';
    mocks.config.otelSdkDisabled = false;
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await Promise.all([initNodeTelemetry(), initNodeTelemetry()]);

    expect(mocks.initializeSentryNodeRequestContext).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledOnce();
    expect(mocks.setLocalTelemetrySummaryRecorder).toHaveBeenCalledOnce();
  });

  it('fails required startup when the Node OTel owner cannot initialize', async () => {
    mocks.config.mode = 'required';
    mocks.config.otelSdkDisabled = false;
    mocks.config.requiredSignals = ['traces'];
    mocks.initOpenTelemetryServer.mockImplementationOnce(() => {
      throw new Error('collector unavailable');
    });
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await expect(initNodeTelemetry()).rejects.toThrow(
      'node during initialization: traces'
    );
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'otel.node.initialize',
      expect.any(Error)
    );
    expect(mocks.installServerTelemetry).not.toHaveBeenCalled();
  });

  it('fails required exception startup when instrumentation is unavailable', async () => {
    mocks.config.mode = 'required';
    mocks.config.otelSdkDisabled = false;
    mocks.config.requiredSignals = ['exceptions'];
    mocks.isServerSentryInstrumentationReady.mockReturnValueOnce(false);
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await expect(initNodeTelemetry()).rejects.toThrow(
      'node during initialization: exceptions'
    );
    expect(mocks.releaseRequestContext).toHaveBeenCalledOnce();
    expect(mocks.shutdownProvider).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).not.toHaveBeenCalled();
  });

  it('preserves the required-signal error when provider cleanup fails', async () => {
    const shutdownFailure = new Error('provider cleanup secret');
    mocks.config.mode = 'required';
    mocks.config.otelSdkDisabled = false;
    mocks.config.requiredSignals = ['exceptions'];
    mocks.isServerSentryInstrumentationReady.mockReturnValueOnce(false);
    mocks.initOpenTelemetryServer.mockReturnValueOnce({
      adapter: createNoOpTelemetry(),
      shutdown: vi.fn().mockRejectedValue(shutdownFailure),
    });
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await expect(initNodeTelemetry()).rejects.toThrow(
      'node during initialization: exceptions'
    );
    expect(mocks.reportTelemetryFailure).toHaveBeenCalledWith(
      'otel.node.required_cleanup',
      shutdownFailure
    );
    expect(mocks.releaseRequestContext).toHaveBeenCalledOnce();
  });

  it('starts when every required Node owner is ready', async () => {
    mocks.config.mode = 'required';
    mocks.config.otelSdkDisabled = false;
    mocks.config.requiredSignals = ['traces', 'metrics', 'logs', 'exceptions'];
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await expect(initNodeTelemetry()).resolves.toBeUndefined();
    expect(mocks.installServerTelemetry).toHaveBeenCalledWith({
      openTelemetry: expect.any(Object),
      sentry: expect.any(Object),
    });
  });
});
