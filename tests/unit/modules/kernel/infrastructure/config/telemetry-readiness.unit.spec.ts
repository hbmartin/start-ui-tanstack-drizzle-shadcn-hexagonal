import { describe, expect, it } from 'vitest';

import {
  assertRequiredTelemetrySignals,
  configuredTelemetrySignalReadiness,
  createTelemetrySignalReadiness,
} from '@/modules/kernel/infrastructure/config/telemetry-readiness';
import type { TelemetryConfig } from '@/modules/kernel/infrastructure/config/telemetry';

const config = (
  input: Partial<TelemetryConfig> &
    Pick<TelemetryConfig, 'mode' | 'requiredSignals'>
): TelemetryConfig =>
  ({
    localSqliteEnabled: false,
    localSqlitePath: '.telemetry/telemetry.sqlite',
    logMaxEvents: 20,
    otelSdkDisabled: input.mode === 'off',
    otelTracesSampleRate: 1,
    proxyMaxBytes: 64 * 1024,
    rateLimitPerMinute: 60,
    requireAuth: false,
    serviceName: 'test-service',
    ...input,
  }) as TelemetryConfig;

describe('required telemetry signal readiness', () => {
  it('requires a collector for every Node OTel signal', () => {
    const requiredConfig = config({
      mode: 'required',
      requiredSignals: ['traces', 'metrics', 'logs'],
    });

    expect(() =>
      assertRequiredTelemetrySignals({
        config: requiredConfig,
        phase: 'configuration',
        profile: 'node',
        readiness: configuredTelemetrySignalReadiness(requiredConfig, 'node'),
      })
    ).toThrow(
      'Required telemetry signals unavailable for node during configuration: traces, metrics, logs.'
    );
  });

  it('treats Vercel traces as profile-owned without a collector', () => {
    const requiredConfig = config({
      mode: 'required',
      requiredSignals: ['traces'],
    });

    expect(() =>
      assertRequiredTelemetrySignals({
        config: requiredConfig,
        phase: 'configuration',
        profile: 'vercel',
        readiness: configuredTelemetrySignalReadiness(requiredConfig, 'vercel'),
      })
    ).not.toThrow();
  });

  it('requires a Sentry DSN for configured exceptions', () => {
    const requiredConfig = config({
      mode: 'required',
      requiredSignals: ['exceptions'],
    });

    expect(() =>
      assertRequiredTelemetrySignals({
        config: requiredConfig,
        phase: 'configuration',
        profile: 'node',
        readiness: configuredTelemetrySignalReadiness(requiredConfig, 'node'),
      })
    ).toThrow('exceptions');
  });

  it('never turns optional readiness gaps into startup failures', () => {
    expect(() =>
      assertRequiredTelemetrySignals({
        config: config({ mode: 'optional', requiredSignals: [] }),
        phase: 'initialization',
        profile: 'node',
        readiness: createTelemetrySignalReadiness(),
      })
    ).not.toThrow();
  });
});
