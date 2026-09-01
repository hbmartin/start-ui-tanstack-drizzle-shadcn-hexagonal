import {
  type DatabaseAdapterKind,
  type RuntimeProfile,
  runtimeCapabilityRequirements,
} from '@/platform/runtime/runtime-profile';
import { getEnvClient } from '@/platform/env/client';

import { ConfigurationError } from '../../domain/errors/configuration-error';
import { getApplicationConfig } from './application';
import { getAuthConfig } from './auth';
import {
  assertDatabaseDriverForRuntimeProfile,
  getDatabaseConfig,
} from './database';
import { getEmailConfig } from './email';
import {
  isProdRuntimeEnvironment,
  shouldSkipEnvValidation,
} from './env-schema';
import { getHttpConfig } from './http';
import { getLoggerConfig } from './logger';
import { getRedisConfig } from './redis';
import { getStorageConfig } from './storage';
import { getTelemetryConfig } from './telemetry';
import {
  assertRequiredTelemetrySignals,
  configuredTelemetrySignalReadiness,
} from './telemetry-readiness';

const validateTrustedClientIpConfiguration = (
  runtimeProfile: RuntimeProfile,
  trustedProxyDepth: number | undefined
) => {
  if (
    runtimeProfile === 'node' &&
    isProdRuntimeEnvironment() &&
    (trustedProxyDepth === undefined || trustedProxyDepth < 1)
  ) {
    throw new ConfigurationError(
      'Node production startup requires TRUSTED_PROXY_DEPTH to be a positive integer matching the trusted reverse-proxy topology.'
    );
  }
};

const validateRuntimeDatabaseConfiguration = (
  runtimeProfile: RuntimeProfile,
  requiredRuntimeServices: boolean,
  runtimeAdapters?: RuntimeServerAdapters
) => {
  if (runtimeProfile === 'cloudflare') {
    const requiredAdapter = runtimeCapabilityRequirements.cloudflare.database;
    if (
      requiredRuntimeServices &&
      runtimeAdapters?.databaseAdapter !== requiredAdapter
    ) {
      throw new ConfigurationError(
        `Cloudflare live startup requires the Worker entrypoint to inject and verify the ${requiredAdapter} database adapter.`
      );
    }
    return;
  }

  const database = getDatabaseConfig();
  assertDatabaseDriverForRuntimeProfile(runtimeProfile, database);
};

const validateServerConfiguration = (
  requiredRuntimeServices: boolean,
  runtimeProfile?: RuntimeProfile,
  runtimeAdapters?: RuntimeServerAdapters
) => {
  if (runtimeProfile === 'cloudflare') {
    // SKIP_ENV_VALIDATION may relax process-owned environment parsing in
    // controlled tests, but it must never bypass the request adapter boundary.
    validateRuntimeDatabaseConfiguration(
      runtimeProfile,
      requiredRuntimeServices,
      runtimeAdapters
    );
  }
  if (shouldSkipEnvValidation()) return;
  const telemetry = getTelemetryConfig();

  if (runtimeProfile) getEnvClient(runtimeProfile);
  const application = getApplicationConfig();
  const http = getHttpConfig();
  if (runtimeProfile) {
    validateTrustedClientIpConfiguration(
      runtimeProfile,
      http.trustedProxyDepth
    );
  }
  getAuthConfig();
  if (runtimeProfile && runtimeProfile !== 'cloudflare') {
    validateRuntimeDatabaseConfiguration(
      runtimeProfile,
      requiredRuntimeServices,
      runtimeAdapters
    );
  } else {
    if (!runtimeProfile) getDatabaseConfig();
  }
  getEmailConfig();
  getLoggerConfig();
  getRedisConfig({ requiredInProduction: requiredRuntimeServices });
  if (application.preset === 'demo') getStorageConfig();
  if (
    requiredRuntimeServices &&
    runtimeProfile &&
    runtimeProfile !== 'cloudflare'
  ) {
    assertRequiredTelemetrySignals({
      config: telemetry,
      phase: 'configuration',
      profile: runtimeProfile,
      readiness: configuredTelemetrySignalReadiness(telemetry, runtimeProfile),
    });
  }
};

export const validateServerBuildConfig = (runtimeProfile: RuntimeProfile) =>
  validateServerConfiguration(false, runtimeProfile);

export type RuntimeServerAdapters = Readonly<{
  databaseAdapter?: DatabaseAdapterKind;
}>;

export const validateServerConfig = (
  runtimeProfile: RuntimeProfile,
  runtimeAdapters?: RuntimeServerAdapters
) => validateServerConfiguration(true, runtimeProfile, runtimeAdapters);
