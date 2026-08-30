import {
  reportTelemetryFailure,
  type TelemetryAdapter,
} from '@/platform/telemetry';

import { forceFlushRequestTelemetry } from '../request-completion';

type WaitUntil = (completion: Promise<unknown>) => void;

export const scheduleCloudflareRequestFlush = (
  request: Request,
  telemetry: TelemetryAdapter,
  waitUntil: WaitUntil
) => {
  const flush = forceFlushRequestTelemetry(request, telemetry).then(
    () => undefined
  );
  try {
    waitUntil(flush);
  } catch (failure) {
    reportTelemetryFailure('otel.cloudflare.wait_until', failure);
  }
};
