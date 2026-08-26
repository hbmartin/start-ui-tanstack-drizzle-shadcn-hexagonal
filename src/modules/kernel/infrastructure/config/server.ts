import type { RuntimeProfile } from '@/platform/runtime/runtime-profile';

import { ConfigurationError } from '../../domain/errors/configuration-error';
import { getApplicationConfig } from './application';
import { getAuthConfig } from './auth';
import { getDatabaseConfig } from './database';
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

export const validateTrustedClientIpConfiguration = (
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

const validateServerConfiguration = (
  requiredRuntimeServices: boolean,
  runtimeProfile?: RuntimeProfile
) => {
  if (shouldSkipEnvValidation()) return;

  const application = getApplicationConfig();
  const http = getHttpConfig();
  if (runtimeProfile) {
    validateTrustedClientIpConfiguration(
      runtimeProfile,
      http.trustedProxyDepth
    );
  }
  getAuthConfig();
  getDatabaseConfig();
  getEmailConfig();
  getLoggerConfig();
  getRedisConfig({ requiredInProduction: requiredRuntimeServices });
  if (application.preset === 'demo') getStorageConfig();
  getTelemetryConfig();
};

export const validateServerBuildConfig = () =>
  validateServerConfiguration(false);

export const validateServerConfig = (runtimeProfile: RuntimeProfile) =>
  validateServerConfiguration(true, runtimeProfile);
