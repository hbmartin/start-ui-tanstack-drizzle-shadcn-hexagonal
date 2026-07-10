import { shouldSkipEnvValidation } from './env-schema';
import { getHttpConfig } from './http';
import { getLoggerConfig } from './logger';
import { getTelemetryConfig } from './telemetry';

export function validateServerConfig() {
  if (shouldSkipEnvValidation()) return;

  getHttpConfig();
  getLoggerConfig();
  getTelemetryConfig();
}
