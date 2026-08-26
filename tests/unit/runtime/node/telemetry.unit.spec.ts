import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createNoOpTelemetry } from '@/platform/telemetry';

const mocks = vi.hoisted(() => ({
  config: {
    dsn: 'https://public@example.invalid/1' as string | undefined,
    otelSdkDisabled: true,
  },
  initOpenTelemetryServer: vi.fn(),
  initializeSentryNodeRequestContext: vi.fn(),
  installPersistentTelemetryLifecycle: vi.fn(),
  installServerTelemetry: vi.fn(),
  releaseRequestContext: vi.fn(),
  reportTelemetryFailure: vi.fn(),
  setLocalTelemetrySummaryRecorder: vi.fn(),
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
vi.mock('@/modules/kernel/backend', () => ({
  getTelemetryConfig: () => mocks.config,
}));
vi.mock('@/platform/telemetry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/platform/telemetry')>()),
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
    mocks.config.otelSdkDisabled = true;
    mocks.initOpenTelemetryServer.mockReturnValue({
      adapter: createNoOpTelemetry(),
      shutdown: vi.fn(),
    });
    mocks.initializeSentryNodeRequestContext.mockReturnValue({
      contextManager: {},
      release: mocks.releaseRequestContext,
    });
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
  });

  it('initializes app-owned OTel when the standard disable flag is false', async () => {
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

  it('shares one initialization across concurrent bootstrap callers', async () => {
    const { initNodeTelemetry } = await import('@/runtime/node/telemetry');

    await Promise.all([initNodeTelemetry(), initNodeTelemetry()]);

    expect(mocks.initializeSentryNodeRequestContext).toHaveBeenCalledOnce();
    expect(mocks.installServerTelemetry).toHaveBeenCalledOnce();
    expect(mocks.setLocalTelemetrySummaryRecorder).toHaveBeenCalledOnce();
  });
});
