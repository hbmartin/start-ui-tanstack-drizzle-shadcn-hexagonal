import { AsyncLocalStorage } from 'node:async_hooks';

import {
  installTelemetryScopeResolver,
  type TelemetryAdapter,
} from '@/platform/telemetry';

const requestTelemetryStorage = new AsyncLocalStorage<TelemetryAdapter>();
const resolveRequestTelemetry = () => requestTelemetryStorage.getStore();
let requestTelemetryScopeInstalled = false;

/** Installs one isolate-wide resolver before the TanStack application loads. */
export const initializeCloudflareTelemetryRequestScope = (): void => {
  if (requestTelemetryScopeInstalled) return;
  installTelemetryScopeResolver(resolveRequestTelemetry);
  requestTelemetryScopeInstalled = true;
};

/** Keeps telemetry selection bound to the current Worker request async graph. */
export const runWithCloudflareTelemetry = <T>(
  telemetry: TelemetryAdapter,
  handle: () => T
): T => requestTelemetryStorage.run(telemetry, handle);
