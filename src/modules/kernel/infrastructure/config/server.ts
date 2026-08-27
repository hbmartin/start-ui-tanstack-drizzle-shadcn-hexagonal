import type { RuntimeProfile } from '@/platform/runtime/runtime-profile';
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
  requiredRuntimeServices: boolean
) => {
  if (runtimeProfile === 'cloudflare') {
    if (requiredRuntimeServices) {
      throw new ConfigurationError(
        'Cloudflare live startup is unavailable until the Worker entrypoint injects and verifies its Hyperdrive database adapter. Artifact build validation remains available.'
      );
    }
    return;
  }

  const database = getDatabaseConfig();
  assertDatabaseDriverForRuntimeProfile(runtimeProfile, database);
};

const validateServerConfiguration = (
  requiredRuntimeServices: boolean,
  runtimeProfile?: RuntimeProfile
) => {
  if (shouldSkipEnvValidation()) return;

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
  if (runtimeProfile) {
    validateRuntimeDatabaseConfiguration(
      runtimeProfile,
      requiredRuntimeServices
    );
  } else {
    getDatabaseConfig();
  }
  getEmailConfig();
  getLoggerConfig();
  getRedisConfig({ requiredInProduction: requiredRuntimeServices });
  if (application.preset === 'demo') getStorageConfig();
  getTelemetryConfig();
};

export const validateServerBuildConfig = (runtimeProfile: RuntimeProfile) =>
  validateServerConfiguration(false, runtimeProfile);

export const validateServerConfig = (runtimeProfile: RuntimeProfile) =>
  validateServerConfiguration(true, runtimeProfile);
