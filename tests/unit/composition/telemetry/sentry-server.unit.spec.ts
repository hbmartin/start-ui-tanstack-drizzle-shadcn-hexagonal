import { describe, expect, it, vi } from 'vitest';

import { installServerTelemetry } from '@/composition/telemetry/sentry.server';
import { createNoOpTelemetry } from '@/platform/telemetry';

describe('server telemetry composition', () => {
  it('keeps optional telemetry disabled when no runtime owner is configured', () => {
    expect(installServerTelemetry({})).toBeUndefined();
  });

  it('combines OTel signals with exception-only Sentry capture', () => {
    const captureException = vi.fn(() => 'event-id');
    const openTelemetry = {
      ...createNoOpTelemetry(),
      currentCorrelation: () => ({
        spanId: '1234567890abcdef',
        traceId: '1234567890abcdef1234567890abcdef',
      }),
    };
    const installed = installServerTelemetry({
      openTelemetry,
      sentry: {
        captureException,
        setUser: vi.fn(),
      },
    });

    installed?.captureException(new Error('internal detail'), {
      level: 'error',
      tags: { event: 'request.failed' },
    });

    expect(captureException).toHaveBeenCalledWith(expect.any(Error), {
      level: 'error',
      tags: {
        event: 'request.failed',
        'otel.span_id': '1234567890abcdef',
        'otel.trace_id': '1234567890abcdef1234567890abcdef',
      },
    });
  });
});
