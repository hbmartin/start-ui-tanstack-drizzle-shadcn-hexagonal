import { getApplicationConfig } from './application';
import { getAuthConfig } from './auth';
import { getDatabaseConfig } from './database';
import { getEmailConfig } from './email';
import { shouldSkipEnvValidation } from './env-schema';
import { getHttpConfig } from './http';
import { getLoggerConfig } from './logger';
import { getRedisConfig } from './redis';
import { getStorageConfig } from './storage';
import { getTelemetryConfig } from './telemetry';

const validateServerConfiguration = (requiredRuntimeServices: boolean) => {
  if (shouldSkipEnvValidation()) return;

  const application = getApplicationConfig();
  getAuthConfig();
  getDatabaseConfig();
  getEmailConfig();
  getHttpConfig();
  getLoggerConfig();
  getRedisConfig({ requiredInProduction: requiredRuntimeServices });
  if (application.preset === 'demo') getStorageConfig();
  getTelemetryConfig();
};

export const validateServerBuildConfig = () =>
  validateServerConfiguration(false);

export const validateServerConfig = () => validateServerConfiguration(true);
