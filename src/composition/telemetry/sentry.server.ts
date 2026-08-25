import type { TelemetryAdapter } from '@/platform/telemetry';

import { createTelemetryAdapterChain } from './adapter-chain';
import { setTelemetry } from './index';
import {
  createSentryTelemetryAdapter,
  type SentryLike,
} from './sentry-adapter';

type InstallServerTelemetryOptions = {
  openTelemetry?: TelemetryAdapter;
  sentry?: SentryLike;
};

/**
 * Installs a vendor-neutral server adapter chain. Runtime entrypoints own SDK
 * initialization and lifecycle so Worker artifacts never retain Node SDKs.
 */
export const installServerTelemetry = ({
  openTelemetry,
  sentry,
}: InstallServerTelemetryOptions): TelemetryAdapter | undefined => {
  const adapters: TelemetryAdapter[] = [];
  if (openTelemetry) adapters.push(openTelemetry);
  if (sentry) {
    adapters.push(
      createSentryTelemetryAdapter(sentry, {
        currentCorrelation: () => openTelemetry?.currentCorrelation() ?? {},
      })
    );
  }
  if (adapters.length === 0) return undefined;

  const installed = createTelemetryAdapterChain(adapters);
  setTelemetry(installed);
  return installed;
};
