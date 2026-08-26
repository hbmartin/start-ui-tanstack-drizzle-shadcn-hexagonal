import { createMiddleware, getGlobalStartContext } from '@tanstack/react-start';

import { AppError } from '@/modules/kernel/domain/errors/app-error';
import {
  claimRequestException,
  isRequestExceptionCaptureState,
  telemetryProxy,
} from '@/platform/telemetry';
import type { RequestExceptionCaptureState } from '@/platform/telemetry';

import {
  isOpaquePublicCorrelationId,
  isPublicServerErrorDto,
  SERVER_FN_ERROR_CODES,
  ServerFnError,
  type ServerFnErrorCode,
} from './server-fn-error';

const MAX_LOGGED_CAUSE_DEPTH = 16;
const safeAppErrorCodePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const serverFnErrorCodeSet = new Set<string>(SERVER_FN_ERROR_CODES);

const safeAppErrorCode = (value: string) =>
  safeAppErrorCodePattern.test(value) ? value : 'APP_ERROR';

const safeErrorType = (error: Error) =>
  /^[A-Za-z][A-Za-z0-9]{0,63}(?:Error)?$/u.test(error.name)
    ? error.name
    : 'Error';

const loggedCause = (error: unknown) => {
  if (error instanceof AppError) {
    return {
      entry: {
        category: error.category,
        code: safeAppErrorCode(error.code),
        status: error.status,
        type: safeErrorType(error),
      },
      next: error.cause,
    };
  }
  if (error instanceof Error) {
    return {
      entry: { type: safeErrorType(error) },
      next: error.cause,
    };
  }
  return { entry: { type: typeof error }, next: undefined };
};

export const serverFnCauseChainForLog = (error: unknown) => {
  const chain: Array<Record<string, unknown>> = [];
  const seen = new Set<unknown>();
  let current: unknown = error;

  while (current !== undefined && current !== null) {
    if (seen.has(current)) {
      chain.push({ type: 'circular_cause' });
      return chain;
    }
    if (chain.length >= MAX_LOGGED_CAUSE_DEPTH) {
      chain.push({ type: 'truncated_cause_chain' });
      return chain;
    }

    seen.add(current);
    const logged = loggedCause(current);
    chain.push(logged.entry);
    current = logged.next;
  }
  return chain;
};

const getServerFnErrorCode = (
  error: unknown
): ServerFnErrorCode | undefined => {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && serverFnErrorCodeSet.has(code)
    ? (code as ServerFnErrorCode)
    : undefined;
};

export const normalizeServerFnError = (
  error: unknown,
  correlationId?: string
): ServerFnError => {
  const requestCorrelationId = isOpaquePublicCorrelationId(correlationId)
    ? correlationId
    : undefined;
  if (error instanceof ServerFnError) {
    return requestCorrelationId
      ? error.withCorrelationId(requestCorrelationId)
      : error;
  }
  if (isPublicServerErrorDto(error)) {
    return ServerFnError.fromPublicDto({
      ...error,
      correlationId: requestCorrelationId ?? error.correlationId,
    });
  }

  return new ServerFnError(
    getServerFnErrorCode(error) ?? 'INTERNAL_SERVER_ERROR',
    {
      correlationId: requestCorrelationId,
      cause: error,
    }
  );
};

type BoundaryContext = {
  requestId?: unknown;
  telemetryCaptureState?: unknown;
};

const globalBoundaryContext = () => {
  try {
    return getGlobalStartContext() as unknown;
  } catch {
    return undefined;
  }
};

const contextCandidates = (context: unknown) => [
  globalBoundaryContext(),
  context,
];

const boundaryRequestId = (context: unknown) => {
  for (const candidate of contextCandidates(context)) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { requestId } = candidate as BoundaryContext;
    if (isOpaquePublicCorrelationId(requestId)) return requestId;
  }
  return undefined;
};

const boundaryCaptureState = (
  context: unknown
): RequestExceptionCaptureState | undefined => {
  for (const candidate of contextCandidates(context)) {
    if (typeof candidate !== 'object' || candidate === null) continue;
    const { telemetryCaptureState } = candidate as BoundaryContext;
    if (isRequestExceptionCaptureState(telemetryCaptureState)) {
      return telemetryCaptureState;
    }
  }
  return undefined;
};

const reportBoundaryError = (
  original: unknown,
  mapped: ServerFnError,
  captureState: RequestExceptionCaptureState | undefined
) => {
  const unexpected = mapped.status >= 500;
  const ownsCapture =
    unexpected &&
    (!captureState || claimRequestException(captureState, original));
  telemetryProxy.emitLog({
    level: unexpected ? 'error' : 'warn',
    event: 'server_fn.error.boundary',
    direction: 'inbound',
    error: mapped.reason,
    details: {
      causeChain: serverFnCauseChainForLog(original),
      correlationId: mapped.correlationId,
      mappedCode: mapped.code,
      mappedReason: mapped.reason,
      mappedStatus: mapped.status,
      mappedTarget: mapped.target,
    },
  });
  if (ownsCapture) {
    telemetryProxy.captureException(original, {
      level: 'error',
      tags: {
        event: 'server_fn.error.boundary',
        requestId: mapped.correlationId,
      },
    });
  }
};

export const serverFnErrorBoundaryMiddleware = createMiddleware({
  type: 'function',
}).server(async ({ context, next }) => {
  try {
    return await next();
  } catch (error) {
    const captureState = boundaryCaptureState(context);
    const mapped = normalizeServerFnError(error, boundaryRequestId(context));
    const { applyServerFnErrorResponse } =
      await import('./server-fn-error-response.server');
    applyServerFnErrorResponse(mapped);
    if (!mapped.reported) {
      reportBoundaryError(error, mapped, captureState);
    }
    const reported = mapped.asReported();
    if (captureState && reported.status >= 500) {
      // Request middleware sees the wrapper, not necessarily its original
      // cause. Claim that exact identity after the boundary-owned capture.
      claimRequestException(captureState, reported);
    }
    throw reported;
  }
});
