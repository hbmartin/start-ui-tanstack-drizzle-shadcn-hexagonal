import type { TextMapGetter } from '@opentelemetry/api';
import { context, propagation } from '@opentelemetry/api';

import type {
  RequestExceptionCaptureState,
  TelemetryAttributes,
  TelemetryMetricInput,
} from '@/platform/telemetry';
import {
  claimRequestException,
  reportTelemetryFailure,
  telemetryProxy,
} from '@/platform/telemetry';
import { isUnexpectedRequestFailure } from '@/platform/http/request-failure';

type RequestObservationInput = {
  request: Request;
  pathname: string;
  handlerType: string;
  requestId?: string;
  captureState?: RequestExceptionCaptureState;
};

const TELEMETRY_ROUTE_PREFIX = '/api/telemetry/';
const UNMATCHED_ROUTE_TEMPLATE = '/unmatched';
const HTTP_METHODS = new Set([
  'DELETE',
  'GET',
  'HEAD',
  'OPTIONS',
  'PATCH',
  'POST',
  'PUT',
]);

const headersGetter: TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: (carrier) => Array.from(carrier.keys()),
};

const isPromiseLike = <T>(value: T): value is T & Promise<Awaited<T>> => {
  try {
    return (
      value != null &&
      (typeof value === 'object' || typeof value === 'function') &&
      'then' in value &&
      typeof (value as { then?: unknown }).then === 'function'
    );
  } catch {
    return false;
  }
};

const normalizeHttpMethod = (method: string) =>
  HTTP_METHODS.has(method) ? method : 'OTHER';

const responseFromResult = (result: unknown): Response | undefined => {
  try {
    if (result instanceof Response) return result;

    if (typeof result !== 'object' || result === null) return undefined;

    const response = (result as { response?: unknown }).response;
    return response instanceof Response ? response : undefined;
  } catch {
    return undefined;
  }
};

const statusClass = (statusCode: number | undefined) =>
  statusCode ? `${Math.floor(statusCode / 100)}xx` : undefined;

const requestMetricAttributes = (
  attributes: TelemetryAttributes,
  result: unknown,
  status: 'success' | 'error'
) => {
  const statusCode = responseFromResult(result)?.status;

  return {
    ...attributes,
    ...(statusCode ? { 'http.response.status_code': statusCode } : {}),
    ...(statusClass(statusCode)
      ? { 'http.response.status_class': statusClass(statusCode) }
      : {}),
    status,
  };
};

const recordRequestMetric = (input: TelemetryMetricInput) => {
  telemetryProxy.recordMetric(input);
};

export function observeHttpRequest<T>(
  {
    request,
    pathname,
    handlerType,
    requestId,
    captureState,
  }: RequestObservationInput,
  next: () => T
): T {
  if (pathname.startsWith(TELEMETRY_ROUTE_PREFIX)) return next();

  const routeTemplate = UNMATCHED_ROUTE_TEMPLATE;
  const url = new URL(request.url);
  const method = normalizeHttpMethod(request.method);
  const metricAttributes = {
    'http.request.method': method,
    'http.route': routeTemplate,
    'tanstack.handler_type': handlerType,
    'url.scheme': url.protocol === 'https:' ? 'https' : 'http',
  } satisfies TelemetryAttributes;
  const spanAttributes = {
    ...metricAttributes,
    ...(requestId ? { 'app.request_id': requestId } : {}),
  } satisfies TelemetryAttributes;
  const startedAt = performance.now();

  const finish = <TValue>(value: TValue): TValue => {
    const durationMs = performance.now() - startedAt;
    recordRequestMetric({
      attributes: requestMetricAttributes(metricAttributes, value, 'success'),
      name: 'app.http.request.duration',
      type: 'histogram',
      unit: 'ms',
      value: durationMs,
    });

    return value;
  };

  const fail = (error: unknown): never => {
    const durationMs = performance.now() - startedAt;
    recordRequestMetric({
      attributes: requestMetricAttributes(metricAttributes, error, 'error'),
      name: 'app.http.request.duration',
      type: 'histogram',
      unit: 'ms',
      value: durationMs,
    });
    if (
      isUnexpectedRequestFailure(error) &&
      (!captureState || claimRequestException(captureState, error))
    ) {
      telemetryProxy.captureException(error, {
        level: 'error',
        tags: {
          event: 'framework.request.failed',
          ...(requestId ? { requestId } : {}),
        },
      });
    }
    throw error;
  };

  type ObservationState = 'not_started' | 'returned' | 'running' | 'threw';
  const observation = { state: 'not_started' as ObservationState };
  let observationResult: T | undefined;
  let observationFailure: unknown;
  const runObservationOnce = (): T => {
    if (observation.state === 'returned') return observationResult as T;
    if (observation.state === 'threw') throw observationFailure;
    if (observation.state === 'running') {
      throw new Error('Telemetry context invoked request work recursively');
    }

    observation.state = 'running';
    try {
      observationResult = telemetryProxy.startSpan(
        {
          attributes: spanAttributes,
          name: 'http.request',
          op: 'http.server',
        },
        () => {
          try {
            const result = next();
            if (!isPromiseLike(result)) return finish(result);

            return result.then(finish, fail) as T;
          } catch (error) {
            return fail(error);
          }
        }
      );
      observation.state = 'returned';
      return observationResult;
    } catch (failure) {
      observationFailure = failure;
      observation.state = 'threw';
      throw failure;
    }
  };

  let extractedContext;
  try {
    extractedContext = propagation.extract(
      context.active(),
      request.headers,
      headersGetter
    );
  } catch (failure) {
    reportTelemetryFailure('otel.context.extract', failure);
    return runObservationOnce();
  }

  let activationResult: T | undefined;
  try {
    activationResult = context.with(extractedContext, runObservationOnce);
  } catch (failure) {
    if (observation.state === 'threw' && failure === observationFailure) {
      throw failure;
    }
    reportTelemetryFailure('otel.context.activate', failure);
    return runObservationOnce();
  }

  if (observation.state === 'not_started') {
    reportTelemetryFailure(
      'otel.context.activate',
      new Error('Telemetry context skipped request work')
    );
  }
  if (activationResult !== observationResult) {
    reportTelemetryFailure(
      'otel.context.activate',
      new Error('Telemetry context substituted the request result')
    );
    if (isPromiseLike(activationResult)) {
      void Promise.resolve(activationResult).catch((failure: unknown) => {
        reportTelemetryFailure('otel.context.activate', failure);
      });
    }
  }

  return runObservationOnce();
}
