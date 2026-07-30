import { getAuthConfig } from './auth';
import { getDatabaseConfig } from './database';
import { getDeployTargetConfig } from './deploy-target';
import { getEmailConfig } from './email';
import { shouldSkipEnvValidation } from './env-schema';
import { getHttpConfig } from './http';
import { getLoggerConfig } from './logger';
import { getOutboxConfig } from './outbox';
import { getRedisConfig } from './redis';
import { getStorageConfig } from './storage';
import { getTelemetryConfig } from './telemetry';

export function validateServerConfig() {
  if (shouldSkipEnvValidation()) return;

  getAuthConfig();
  getDatabaseConfig();
  getDeployTargetConfig();
  getEmailConfig();
  getHttpConfig();
  getLoggerConfig();
  getOutboxConfig();
  getRedisConfig();
  getStorageConfig();
  getTelemetryConfig();
}
