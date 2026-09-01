import type { RuntimeProfile } from '@/platform/runtime/runtime-profile';
import {
  telemetrySignals,
  type TelemetrySignal,
  type TelemetrySignalReadiness,
} from '@/platform/telemetry';

import { ConfigurationError } from '../../domain/errors/configuration-error';
import type { TelemetryConfig } from './telemetry';

export type TelemetryReadinessPhase =
  | 'configuration'
  | 'initialization'
  | 'request';

export const createTelemetrySignalReadiness = (
  readiness: Partial<TelemetrySignalReadiness> = {}
): TelemetrySignalReadiness => ({
  exceptions: readiness.exceptions ?? false,
  logs: readiness.logs ?? false,
  metrics: readiness.metrics ?? false,
  traces: readiness.traces ?? false,
});

export const configuredTelemetrySignalReadiness = (
  config: TelemetryConfig,
  profile: RuntimeProfile
): TelemetrySignalReadiness => {
  const openTelemetryEnabled = config.mode !== 'off';
  const collectorReady = openTelemetryEnabled && Boolean(config.collectorUrl);
  return createTelemetrySignalReadiness({
    exceptions: Boolean(config.dsn),
    logs: profile === 'cloudflare' ? false : collectorReady,
    metrics: profile === 'cloudflare' ? false : collectorReady,
    traces:
      profile === 'vercel'
        ? openTelemetryEnabled
        : profile === 'node'
          ? collectorReady
          : false,
  });
};

export const isTelemetrySignalRequired = (
  config: Pick<TelemetryConfig, 'mode' | 'requiredSignals'>,
  signal: TelemetrySignal
) => config.mode === 'required' && config.requiredSignals.includes(signal);

export const assertRequiredTelemetrySignals = ({
  config,
  phase,
  profile,
  readiness,
}: {
  config: Pick<TelemetryConfig, 'mode' | 'requiredSignals'>;
  phase: TelemetryReadinessPhase;
  profile: RuntimeProfile;
  readiness: TelemetrySignalReadiness;
}) => {
  if (config.mode !== 'required') return;

  const missingSignals = telemetrySignals.filter(
    (signal) => config.requiredSignals.includes(signal) && !readiness[signal]
  );
  if (missingSignals.length === 0) return;

  throw new ConfigurationError(
    `Required telemetry signals unavailable for ${profile} during ${phase}: ${missingSignals.join(', ')}.`,
    {
      details: {
        missingSignals,
        phase,
        profile,
      },
    }
  );
};
