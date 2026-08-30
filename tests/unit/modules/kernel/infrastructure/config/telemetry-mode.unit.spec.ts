import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loadTelemetryConfig = async () => {
  const { getTelemetryConfig } =
    await import('@/modules/kernel/infrastructure/config/telemetry');
  return getTelemetryConfig();
};

describe('telemetry mode configuration', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('defaults to optional full sampling with no required signals', async () => {
    expect(await loadTelemetryConfig()).toMatchObject({
      mode: 'optional',
      otelSdkDisabled: false,
      otelTracesSampleRate: 1,
      requiredSignals: [],
    });
  });

  it.each(['mandatory', ' REQUIRED ', 'Optional'])(
    'rejects invalid closed telemetry mode %j',
    async (mode) => {
      vi.stubEnv('TELEMETRY_MODE', mode);

      await expect(loadTelemetryConfig()).rejects.toThrow('TELEMETRY_MODE');
    }
  );

  it('parses, deduplicates, and canonically orders required signals', async () => {
    vi.stubEnv('TELEMETRY_MODE', 'required');
    vi.stubEnv('TELEMETRY_REQUIRED_SIGNALS', ' exceptions,logs,traces,logs ');

    expect(await loadTelemetryConfig()).toMatchObject({
      mode: 'required',
      otelSdkDisabled: false,
      requiredSignals: ['traces', 'logs', 'exceptions'],
    });
  });

  it.each(['', 'traces,,logs', 'profiles'])(
    'rejects malformed required signal input %j',
    async (requiredSignals) => {
      vi.stubEnv('TELEMETRY_MODE', 'required');
      vi.stubEnv('TELEMETRY_REQUIRED_SIGNALS', requiredSignals);

      await expect(loadTelemetryConfig()).rejects.toThrow(
        'TELEMETRY_REQUIRED_SIGNALS'
      );
    }
  );

  it('requires an explicit non-empty signal set in required mode', async () => {
    vi.stubEnv('TELEMETRY_MODE', 'required');

    await expect(loadTelemetryConfig()).rejects.toThrow(
      'TELEMETRY_MODE=required requires at least one TELEMETRY_REQUIRED_SIGNALS'
    );
  });

  it.each(['off', 'optional'] as const)(
    'rejects required signals while mode is %s',
    async (mode) => {
      vi.stubEnv('TELEMETRY_MODE', mode);
      vi.stubEnv('TELEMETRY_REQUIRED_SIGNALS', 'traces');

      await expect(loadTelemetryConfig()).rejects.toThrow(
        'TELEMETRY_REQUIRED_SIGNALS may only be set'
      );
    }
  );

  it('keeps Sentry exceptions independently configured when OTel is off', async () => {
    vi.stubEnv('TELEMETRY_MODE', 'off');
    vi.stubEnv('SENTRY_DSN', 'https://public@example.invalid/1');

    expect(await loadTelemetryConfig()).toMatchObject({
      dsn: 'https://public@example.invalid/1',
      mode: 'off',
      otelSdkDisabled: true,
      requiredSignals: [],
    });
  });

  it('accepts a disabled provider flag only with explicit off mode', async () => {
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');
    vi.stubEnv('TELEMETRY_MODE', 'off');

    expect(await loadTelemetryConfig()).toMatchObject({
      mode: 'off',
      otelSdkDisabled: true,
    });
  });

  it('rejects a disabled provider flag when explicit mode is absent', async () => {
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');

    await expect(loadTelemetryConfig()).rejects.toThrow(
      'Set TELEMETRY_MODE=off explicitly'
    );
  });

  it('rejects OTEL_SDK_DISABLED=true with explicit optional mode', async () => {
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');
    vi.stubEnv('TELEMETRY_MODE', 'optional');

    await expect(loadTelemetryConfig()).rejects.toThrow(
      'OTEL_SDK_DISABLED=true conflicts with TELEMETRY_MODE'
    );
  });

  it('rejects OTEL_SDK_DISABLED=true with explicit required mode', async () => {
    vi.stubEnv('OTEL_SDK_DISABLED', 'true');
    vi.stubEnv('TELEMETRY_MODE', 'required');
    vi.stubEnv('TELEMETRY_REQUIRED_SIGNALS', 'traces');

    await expect(loadTelemetryConfig()).rejects.toThrow(
      'OTEL_SDK_DISABLED=true conflicts with TELEMETRY_MODE'
    );
  });
});
