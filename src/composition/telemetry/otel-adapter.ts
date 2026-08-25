import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  TraceFlags,
} from '@opentelemetry/api';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

import type {
  TelemetryAdapter,
  TelemetryAttributes,
  TelemetryCaptureContext,
  TelemetryLogLevel,
  TelemetrySpanHandle,
  TelemetrySpanOptions,
} from '@/platform/telemetry';

const INSTRUMENTATION_SCOPE = 'start-ui-web';
const MAX_ATTRIBUTE_LENGTH = 256;
const SAFE_EVENT_NAME = /^[a-z][a-z0-9_.-]{0,127}$/u;
const SAFE_ATTRIBUTE_TEXT = /^[a-zA-Z0-9_./:$-]+$/u;
const SAFE_ERROR_TYPE = /^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/u;
const SAFE_ERROR_CODE = /^[a-zA-Z0-9_.-]{1,128}$/u;
const SAFE_ERROR_CATEGORIES = new Set([
  'bad_request',
  'unauthorized',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limit',
  'system',
]);
const MAX_CAUSE_DEPTH = 8;
const SAFE_METRIC_NAMES = new Set([
  'app.db.operation.duration',
  'app.http.request.duration',
  'app.query.cache.event',
  'app.query.operation.duration',
  'app.route.boundary.duration',
  'app.router.navigation.duration',
  'app.server_function.duration',
]);
const SAFE_METRIC_UNITS = new Set(['1', 'By', 'ms', 's']);
const SPAN_NAME_BY_OPERATION: Readonly<Record<string, string>> = {
  'auth.http': 'auth.http',
  'auth.provider': 'auth.provider',
  'db.repository': 'db.repository',
  'http.server': 'http.request',
  'router.beforeLoad': 'route.beforeLoad',
  'router.loader': 'route.loader',
  'router.navigation': 'router.navigation',
  'server.function': 'server.function',
  'tanstack.mutation': 'query.mutation',
  'tanstack.query': 'query.read',
  'upload.before_upload': 'upload.before_upload',
  'upload.http': 'upload.http',
};
const CREDENTIAL_VALUE =
  /\b(?:bearer|basic)\s+\S+|\b(?:api|pk|sk)[-_][a-zA-Z0-9_-]{6,}/giu;

const SPAN_ATTRIBUTE_KEYS = new Set([
  'app.request_id',
  'auth.provider',
  'db.collection.name',
  'db.operation.duration_ms',
  'db.operation.name',
  'db.system',
  'file.mime_type',
  'http.request.method',
  'http.response.status_class',
  'http.response.status_code',
  'http.route',
  'navigation.duration_ms',
  'navigation.hash_changed',
  'navigation.path_changed',
  'navigation.status',
  'operation.key_dynamic_count',
  'operation.type',
  'route.id',
  'route.phase',
  'route.template',
  'server.address',
  'status',
  'tanstack.handler_type',
  'upload.provider',
  'upload.route',
  'url.scheme',
]);

const METRIC_ATTRIBUTE_KEYS = new Set([
  'auth.provider',
  'db.collection.name',
  'db.operation.name',
  'db.system',
  'file.mime_type',
  'http.request.method',
  'http.response.status_class',
  'http.response.status_code',
  'http.route',
  'navigation.status',
  'operation.key_dynamic_count',
  'operation.type',
  'route.id',
  'route.phase',
  'route.template',
  'status',
  'tanstack.handler_type',
  'upload.provider',
  'upload.route',
  'url.scheme',
]);

const LOG_ATTRIBUTE_KEYS = new Set(['correlationId', 'requestId', 'scopeKey']);
const CAPTURE_TAG_KEYS = new Set([
  'attempt',
  'auth.operation',
  'auth.secondary_store',
  'correlationId',
  'event',
  'operation',
  'provider',
  'requestId',
  'retryable',
  'routeId',
  'source',
]);

type OtelSpan = ReturnType<ReturnType<typeof trace.getTracer>['startSpan']>;
type OtelCounter = ReturnType<
  ReturnType<typeof metrics.getMeter>['createCounter']
>;
type OtelHistogram = ReturnType<
  ReturnType<typeof metrics.getMeter>['createHistogram']
>;

const severityByLevel = {
  debug: SeverityNumber.DEBUG,
  error: SeverityNumber.ERROR,
  info: SeverityNumber.INFO,
  warn: SeverityNumber.WARN,
} as const satisfies Record<TelemetryLogLevel, SeverityNumber>;

const severityTextByLevel = {
  debug: 'DEBUG',
  error: 'ERROR',
  info: 'INFO',
  warn: 'WARN',
} as const satisfies Record<TelemetryLogLevel, string>;

const captureSeverityByLevel = {
  debug: SeverityNumber.DEBUG,
  error: SeverityNumber.ERROR,
  fatal: SeverityNumber.FATAL,
  info: SeverityNumber.INFO,
  warning: SeverityNumber.WARN,
} as const satisfies Record<
  NonNullable<TelemetryCaptureContext['level']>,
  SeverityNumber
>;

const captureSeverityTextByLevel = {
  debug: 'DEBUG',
  error: 'ERROR',
  fatal: 'FATAL',
  info: 'INFO',
  warning: 'WARN',
} as const satisfies Record<
  NonNullable<TelemetryCaptureContext['level']>,
  string
>;

const statusCodeByStatus = {
  error: SpanStatusCode.ERROR,
  ok: SpanStatusCode.OK,
  unset: SpanStatusCode.UNSET,
} as const;

const isPromiseLike = <T>(value: T): value is T & Promise<Awaited<T>> =>
  value !== null &&
  value !== undefined &&
  typeof value === 'object' &&
  'then' in value &&
  typeof (value as { then?: unknown }).then === 'function';

const errorType = (error: unknown): string => {
  try {
    if (error instanceof Error) {
      return SAFE_ERROR_TYPE.test(error.name) ? error.name : 'Error';
    }
    return error === null ? 'null' : typeof error;
  } catch {
    return 'uninspectable';
  }
};

const isResultError = (value: unknown): value is { error: unknown } =>
  value !== null &&
  typeof value === 'object' &&
  'tag' in value &&
  value.tag === 'Error' &&
  'error' in value;

const compactAttributes = (
  attributes: TelemetryAttributes | undefined,
  allowedKeys: ReadonlySet<string>
): Record<string, string | number | boolean> => {
  const compacted: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (!allowedKeys.has(key) || value === undefined) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) compacted[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      compacted[key] = value;
      continue;
    }

    const bounded = value
      .replace(CREDENTIAL_VALUE, '[REDACTED]')
      .replace(/([?#]).*$/u, '')
      .slice(0, MAX_ATTRIBUTE_LENGTH);
    if (SAFE_ATTRIBUTE_TEXT.test(bounded)) compacted[key] = bounded;
  }
  return compacted;
};

const metricAttributes = (attributes: TelemetryAttributes | undefined) =>
  compactAttributes(attributes, METRIC_ATTRIBUTE_KEYS);

const spanAttributes = (attributes: TelemetryAttributes | undefined) =>
  compactAttributes(attributes, SPAN_ATTRIBUTE_KEYS);

type ActiveSpanContext = {
  spanId?: string;
  traceId?: string;
};

type SafeProperty = { ok: true; value: unknown } | { ok: false };
type ErrorCauseProjection = {
  category?: string;
  code?: string;
  type: string;
};

const safeProperty = (value: object, key: string): SafeProperty => {
  try {
    return { ok: true, value: Reflect.get(value, key) };
  } catch {
    return { ok: false };
  }
};

const isInspectableFailure = (failure: unknown): failure is object =>
  (typeof failure === 'object' && failure !== null) ||
  typeof failure === 'function';

const projectErrorCause = (failure: unknown): ErrorCauseProjection => {
  const projection: ErrorCauseProjection = { type: errorType(failure) };
  if (!isInspectableFailure(failure)) return projection;

  const code = safeProperty(failure, 'code');
  if (
    code.ok &&
    typeof code.value === 'string' &&
    SAFE_ERROR_CODE.test(code.value)
  ) {
    projection.code = code.value;
  }
  const category = safeProperty(failure, 'category');
  if (
    category.ok &&
    typeof category.value === 'string' &&
    SAFE_ERROR_CATEGORIES.has(category.value)
  ) {
    projection.category = category.value;
  }
  return projection;
};

const projectErrorCauseChain = (failure: unknown) => {
  const causes: ErrorCauseProjection[] = [];
  const seen = new WeakSet<object>();
  let candidate: unknown = failure;
  let truncated = false;

  while (candidate !== undefined && causes.length < MAX_CAUSE_DEPTH) {
    if (isInspectableFailure(candidate)) {
      if (seen.has(candidate)) {
        truncated = true;
        break;
      }
      seen.add(candidate);
    }

    causes.push(projectErrorCause(candidate));
    if (!isInspectableFailure(candidate)) break;

    const next = safeProperty(candidate, 'cause');
    if (!next.ok) {
      truncated = true;
      break;
    }
    candidate = next.value;
  }

  if (candidate !== undefined && causes.length >= MAX_CAUSE_DEPTH) {
    truncated = true;
  }
  return { causes, truncated };
};

const captureAttributes = (
  captureContext: TelemetryCaptureContext | undefined,
  spanContext: ActiveSpanContext | undefined
) => ({
  ...compactAttributes(captureContext?.tags, CAPTURE_TAG_KEYS),
  ...(spanContext?.spanId ? { 'span.id': spanContext.spanId } : {}),
  ...(spanContext?.traceId ? { 'trace.id': spanContext.traceId } : {}),
});

const eventNameFromCaptureContext = (
  captureContext: TelemetryCaptureContext | undefined
) => {
  const event = captureContext?.tags?.event;
  return typeof event === 'string' && SAFE_EVENT_NAME.test(event)
    ? event
    : 'exception.captured';
};

const eventNameFromLog = (event: string) =>
  SAFE_EVENT_NAME.test(event) ? event : 'application.log';

const spanNameFromOptions = (options: TelemetrySpanOptions) =>
  options.op
    ? (SPAN_NAME_BY_OPERATION[options.op] ?? 'application.span')
    : 'application.span';

const metricName = (name: string, type: 'counter' | 'histogram' | undefined) =>
  SAFE_METRIC_NAMES.has(name)
    ? name
    : type === 'counter'
      ? 'application.counter'
      : 'application.histogram';

const metricUnit = (unit: string | undefined) =>
  unit && SAFE_METRIC_UNITS.has(unit) ? unit : undefined;

const manualSpanHandle = (span: OtelSpan): TelemetrySpanHandle => ({
  addEvent: (name, attributes) => {
    span.addEvent(
      SAFE_EVENT_NAME.test(name) ? name : 'application.span_event',
      spanAttributes(attributes)
    );
  },
  end: () => {
    span.end();
  },
  setAttributes: (attributes) => {
    span.setAttributes(spanAttributes(attributes));
  },
  setStatus: (status) => {
    span.setStatus({
      code: statusCodeByStatus[status],
    });
  },
});

const completeSpanForResult = (span: OtelSpan, value: unknown) => {
  if (isResultError(value)) {
    span.setAttribute('error.type', errorType(value.error));
    span.setStatus({ code: SpanStatusCode.ERROR });
    return;
  }

  span.setStatus({ code: SpanStatusCode.OK });
};

type OpenTelemetryAdapterOptions = {
  forceFlush?: () => Promise<void>;
};

export const createOpenTelemetryAdapter = ({
  forceFlush = () => Promise.resolve(),
}: OpenTelemetryAdapterOptions = {}): TelemetryAdapter => {
  const counters = new Map<string, OtelCounter>();
  const histograms = new Map<string, OtelHistogram>();

  const getCounter = (name: string, unit: string | undefined) => {
    const key = `${name}:${unit ?? ''}`;
    const existing = counters.get(key);
    if (existing) return existing;

    const created = metrics
      .getMeter(INSTRUMENTATION_SCOPE)
      .createCounter(name, unit ? { unit } : {});
    counters.set(key, created);
    return created;
  };

  const getHistogram = (name: string, unit: string | undefined) => {
    const key = `${name}:${unit ?? ''}`;
    const existing = histograms.get(key);
    if (existing) return existing;

    const created = metrics
      .getMeter(INSTRUMENTATION_SCOPE)
      .createHistogram(name, unit ? { unit } : {});
    histograms.set(key, created);
    return created;
  };

  return {
    captureException: (error, captureContext) => {
      const activeSpan = trace.getActiveSpan();
      const spanContext = activeSpan?.spanContext();
      const level = captureContext?.level ?? 'error';
      const eventName = eventNameFromCaptureContext(captureContext);

      activeSpan?.setAttribute('error.type', errorType(error));
      activeSpan?.setStatus({ code: SpanStatusCode.ERROR });

      logs.getLogger(INSTRUMENTATION_SCOPE).emit({
        attributes: captureAttributes(captureContext, spanContext),
        body: {
          error: projectErrorCauseChain(error),
          event: eventName,
        },
        eventName,
        severityNumber: captureSeverityByLevel[level],
        severityText: captureSeverityTextByLevel[level],
        context: context.active(),
      });
    },
    currentCorrelation: () => {
      const activeSpan = trace.getActiveSpan();
      const spanContext = activeSpan?.spanContext();
      if (!spanContext) return {};

      return {
        spanId: spanContext.spanId,
        traceId: spanContext.traceId,
        sampled: Boolean(spanContext.traceFlags & TraceFlags.SAMPLED),
      };
    },
    emitLog: (record) => {
      const correlation = trace.getActiveSpan()?.spanContext();
      const eventName = eventNameFromLog(record.event);
      logs.getLogger(INSTRUMENTATION_SCOPE).emit({
        attributes: {
          ...compactAttributes(record.attributes, LOG_ATTRIBUTE_KEYS),
          ...(record.direction ? { direction: record.direction } : {}),
          ...(correlation?.spanId ? { 'span.id': correlation.spanId } : {}),
          ...(correlation?.traceId ? { 'trace.id': correlation.traceId } : {}),
        },
        body: eventName,
        eventName,
        severityNumber: severityByLevel[record.level],
        severityText: severityTextByLevel[record.level],
        timestamp: record.timestamp,
        context: context.active(),
      });
    },
    forceFlush,
    recordMetric: (input) => {
      const name = metricName(input.name, input.type);
      const unit = metricUnit(input.unit);
      if (input.type === 'counter') {
        getCounter(name, unit).add(
          input.value,
          metricAttributes(input.attributes)
        );
        return;
      }

      getHistogram(name, unit).record(
        input.value,
        metricAttributes(input.attributes)
      );
    },
    setUser: () => {},
    startManualSpan: (options) => {
      const span = trace
        .getTracer(INSTRUMENTATION_SCOPE)
        .startSpan(spanNameFromOptions(options), {
          attributes: spanAttributes(options.attributes),
        });
      return manualSpanHandle(span);
    },
    startSpan: (options: TelemetrySpanOptions, fn) =>
      trace
        .getTracer(INSTRUMENTATION_SCOPE)
        .startActiveSpan(
          spanNameFromOptions(options),
          { attributes: spanAttributes(options.attributes) },
          (span) => {
            try {
              const result = fn();
              if (!isPromiseLike(result)) {
                completeSpanForResult(span, result);
                span.end();
                return result;
              }

              return result
                .then((value) => {
                  completeSpanForResult(span, value);
                  return value;
                })
                .catch((error: unknown) => {
                  span.setAttribute('error.type', errorType(error));
                  span.setStatus({ code: SpanStatusCode.ERROR });
                  throw error;
                })
                .finally(() => {
                  span.end();
                }) as typeof result;
            } catch (error) {
              span.setAttribute('error.type', errorType(error));
              span.setStatus({ code: SpanStatusCode.ERROR });
              span.end();
              throw error;
            }
          }
        ),
  };
};
