import {
  setResponseHeader,
  setResponseStatus,
} from '@tanstack/react-start/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { serverFnErrorBoundaryMiddleware } from '@/modules/kernel/middleware';
import { ServerFnError, serverFnValidator } from '@/modules/kernel/server';
import {
  createNoOpTelemetry,
  createRequestExceptionCaptureState,
  setTelemetry,
} from '@/platform/telemetry';

const REQUEST_ID = '53b49589-2ca2-4c8a-b70a-bb2d7835523c';
const boundaryHandler = (serverFnErrorBoundaryMiddleware as ExplicitAny)
  .handler;

const telemetrySpies = {
  captureException: vi.fn(),
  emitLog: vi.fn(),
};

beforeEach(() => {
  setTelemetry({
    ...createNoOpTelemetry(),
    ...telemetrySpies,
  });
});

describe('global server-function error boundary', () => {
  it('closes and reports validator failures before the handler phase', async () => {
    const validate = serverFnValidator(z.object({ id: z.uuid() }));
    const validationError = await validate({ id: 'hostile-secret' }).catch(
      (error: unknown) => error
    );
    const next = vi.fn().mockRejectedValue(validationError);

    const mapped = await boundaryHandler({
      context: { requestId: REQUEST_ID },
      next,
    }).catch((error: unknown) => error);

    expect(mapped).toBeInstanceOf(ServerFnError);
    expect(mapped.toJSON()).toEqual({
      correlationId: REQUEST_ID,
      reason: 'invalid_input',
      target: 'request',
      version: 1,
    });
    expect(JSON.stringify(mapped)).not.toMatch(/hostile|message|stack|cause/iu);
    expect(setResponseStatus).toHaveBeenCalledWith(400);
    expect(telemetrySpies.emitLog).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'server_fn.error.boundary',
        level: 'warn',
      })
    );
    expect(JSON.stringify(telemetrySpies.emitLog.mock.calls)).not.toContain(
      'hostile-secret'
    );
    expect(telemetrySpies.captureException).not.toHaveBeenCalled();
  });

  it('captures an unexpected pre-handler failure once and exposes only the DTO', async () => {
    const original = new Error('provider-secret at db.internal?token=secret');
    const captureState = createRequestExceptionCaptureState();
    const mapped = await boundaryHandler({
      context: {
        requestId: REQUEST_ID,
        telemetryCaptureState: captureState,
      },
      next: vi.fn().mockRejectedValue(original),
    }).catch((error: unknown) => error);

    expect(mapped.toJSON()).toEqual({
      correlationId: REQUEST_ID,
      reason: 'internal_error',
      target: 'system',
      version: 1,
    });
    expect(JSON.stringify(mapped)).not.toMatch(
      /provider-secret|db\.internal|token=secret/iu
    );
    expect(setResponseStatus).toHaveBeenCalledWith(500);
    expect(telemetrySpies.captureException).toHaveBeenCalledOnce();
    expect(telemetrySpies.captureException).toHaveBeenCalledWith(
      original,
      expect.any(Object)
    );
    expect(captureState.captured.has(original)).toBe(true);
  });

  it('returns real bounded 429 response metadata', async () => {
    const mapped = await boundaryHandler({
      context: { requestId: REQUEST_ID },
      next: vi.fn().mockRejectedValue(
        new ServerFnError('TOO_MANY_REQUESTS', {
          retryAfterSeconds: 9999,
        })
      ),
    }).catch((error: unknown) => error);

    expect(mapped).toMatchObject({ status: 429, retryAfterSeconds: 60 });
    expect(setResponseStatus).toHaveBeenCalledWith(429);
    expect(setResponseHeader).toHaveBeenCalledWith('Retry-After', '60');
  });

  it('does not duplicate logs for errors already reported by a context runner', async () => {
    await boundaryHandler({
      context: { requestId: REQUEST_ID },
      next: vi.fn().mockRejectedValue(
        new ServerFnError('FORBIDDEN', {
          correlationId: REQUEST_ID,
        }).asReported()
      ),
    }).catch(() => undefined);

    expect(setResponseStatus).toHaveBeenCalledWith(403);
    expect(telemetrySpies.emitLog).not.toHaveBeenCalled();
    expect(telemetrySpies.captureException).not.toHaveBeenCalled();
  });
});
