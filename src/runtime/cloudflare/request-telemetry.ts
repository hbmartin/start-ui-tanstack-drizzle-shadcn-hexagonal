import type { CloudflareOptions } from '@sentry/cloudflare';

import { createTelemetryAdapterChain } from '@/composition/telemetry/adapter-chain';
import { createSentryTelemetryAdapter } from '@/composition/telemetry/sentry-adapter';
import {
  createCloudflareSentryOptions,
  type CloudflareSentryEnvironment,
} from '@/composition/telemetry/sentry-cloudflare-options';
import {
  reportTelemetryFailure,
  setTelemetry,
  type TelemetryAdapter,
} from '@/platform/telemetry';

type CloudflareSentryApi = Parameters<typeof createCloudflareSentryOptions>[0] &
  Parameters<typeof createSentryTelemetryAdapter>[0];

export type CloudflareRequestTelemetryConfiguration = {
  sentryOptions?: CloudflareOptions;
};

/**
 * Installs the native adapter first, then attempts the optional Sentry layer.
 * A provider/configuration failure leaves the application on native telemetry.
 */
export const configureCloudflareRequestTelemetry = ({
  environment,
  nativeTelemetry,
  request,
  sentry,
  sentryRequestIsolationReady,
}: {
  environment: CloudflareSentryEnvironment;
  nativeTelemetry: TelemetryAdapter;
  request: Request;
  sentry: CloudflareSentryApi;
  sentryRequestIsolationReady: boolean;
}): CloudflareRequestTelemetryConfiguration => {
  setTelemetry(nativeTelemetry);
  if (!environment.SENTRY_DSN || !sentryRequestIsolationReady) {
    return {};
  }

  try {
    const sentryOptions = createCloudflareSentryOptions(
      sentry,
      request,
      environment
    );
    const sentryTelemetry = createSentryTelemetryAdapter(sentry, {
      flushOwner: 'request-wrapper',
    });
    setTelemetry(
      createTelemetryAdapterChain([nativeTelemetry, sentryTelemetry])
    );
    return { sentryOptions };
  } catch (failure) {
    reportTelemetryFailure('sentry.cloudflare.configure', failure);
    return {};
  }
};
