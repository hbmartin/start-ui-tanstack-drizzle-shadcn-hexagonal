import { getTelemetry, reportTelemetryFailure } from '@/platform/telemetry';

import { forceFlushRequestTelemetry } from '../request-completion';

type WaitUntil = (completion: Promise<unknown>) => void;

export const scheduleCloudflareRequestFlush = (
  request: Request,
  waitUntil: WaitUntil
) => {
  const flush = forceFlushRequestTelemetry(request, getTelemetry()).then(
    () => undefined
  );
  try {
    waitUntil(flush);
  } catch (failure) {
    reportTelemetryFailure('otel.cloudflare.wait_until', failure);
  }
};
