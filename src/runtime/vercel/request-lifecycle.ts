import { waitUntil } from '@vercel/functions';

import { getTelemetry, reportTelemetryFailure } from '@/platform/telemetry';

import { forceFlushRequestTelemetry } from '../request-completion';
import type { RuntimeRequestLifecycle } from '../create-application-server-entry';

export const vercelRequestLifecycle: RuntimeRequestLifecycle = {
  onRequestSettled(request) {
    const flush = forceFlushRequestTelemetry(request, getTelemetry()).then(
      () => undefined
    );
    try {
      waitUntil(flush);
    } catch (failure) {
      reportTelemetryFailure('otel.vercel.wait_until', failure);
    }
  },
};
