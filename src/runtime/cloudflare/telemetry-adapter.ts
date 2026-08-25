import type {
  TelemetryAdapter,
  TelemetryAttributes,
  TelemetrySpanHandle,
  TelemetrySpanOptions,
} from '@/platform/telemetry';
import { writeStructuredConsoleLog } from '@/platform/telemetry';

type NativeSpan = {
  end(): void;
  setAttribute(key: string, value: boolean | number | string): NativeSpan;
  setAttributes(
    attributes: Record<string, boolean | number | string | undefined>
  ): NativeSpan;
};

export type CloudflareTracing = {
  enterSpan<T>(name: string, callback: (span: NativeSpan) => T): T;
  startActiveSpan<T>(name: string, callback: (span: NativeSpan) => T): T;
  startSpan(name: string): NativeSpan;
};

export type CloudflareAnalyticsEngine = {
  writeDataPoint(event: {
    indexes?: Array<ArrayBuffer | string | null>;
    doubles?: number[];
    blobs?: Array<ArrayBuffer | string | null>;
  }): void;
};

const EVENT_NAME = /^[a-z][a-z0-9_.-]{0,127}$/u;
const SAFE_TEXT = /^[a-zA-Z0-9_./:$-]{1,256}$/u;
const MAX_TEXT_LENGTH = 256;
const CREDENTIAL_VALUE =
  /\b(?:bearer|basic)\s+\S+|\b(?:api|pk|sk)[-_][a-zA-Z0-9_-]{6,}/giu;
const SAFE_METRIC_NAMES = new Set([
  'app.db.operation.duration',
  'app.http.request.duration',
  'app.query.cache.event',
  'app.query.operation.duration',
  'app.route.boundary.duration',
  'app.router.navigation.duration',
  'app.server_function.duration',
]);
const ATTRIBUTE_KEYS = new Set([
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
const SPAN_NAMES: Readonly<Record<string, string>> = {
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

const compactAttributes = (attributes: TelemetryAttributes | undefined) => {
  const projected: Record<string, boolean | number | string> = {};
  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (!ATTRIBUTE_KEYS.has(key) || value === undefined) continue;
    if (typeof value === 'number') {
      if (Number.isFinite(value)) projected[key] = value;
      continue;
    }
    if (typeof value === 'boolean') {
      projected[key] = value;
      continue;
    }
    const text = value
      .replace(CREDENTIAL_VALUE, '[REDACTED]')
      .replace(/([?#]).*$/u, '')
      .slice(0, MAX_TEXT_LENGTH);
    if (SAFE_TEXT.test(text)) projected[key] = text;
  }
  return projected;
};

const eventName = (value: unknown, fallback: string) =>
  typeof value === 'string' && EVENT_NAME.test(value) ? value : fallback;

const errorType = (failure: unknown) => {
  try {
    return failure instanceof Error && SAFE_TEXT.test(failure.name)
      ? failure.name
      : failure === null
        ? 'null'
        : typeof failure;
  } catch {
    return 'uninspectable';
  }
};

const spanName = (options: TelemetrySpanOptions) =>
  options.op
    ? (SPAN_NAMES[options.op] ?? 'application.span')
    : 'application.span';

const spanHandle = (span: NativeSpan): TelemetrySpanHandle => ({
  addEvent: (name, attributes) => {
    span.setAttributes({
      ...compactAttributes(attributes),
      'event.name': eventName(name, 'application.span_event'),
    });
  },
  end: () => span.end(),
  setAttributes: (attributes) =>
    span.setAttributes(compactAttributes(attributes)),
  setStatus: (status) => span.setAttribute('status', status),
});

const isPromiseLike = <T>(value: T): value is T & Promise<Awaited<T>> => {
  try {
    return (
      value !== null &&
      value !== undefined &&
      (typeof value === 'object' || typeof value === 'function') &&
      'then' in value &&
      typeof (value as { then?: unknown }).then === 'function'
    );
  } catch {
    return false;
  }
};

export const createCloudflareTelemetryAdapter = ({
  analytics,
  tracing,
}: {
  analytics?: CloudflareAnalyticsEngine;
  tracing: CloudflareTracing;
}): TelemetryAdapter => ({
  captureException: (failure, context) => {
    writeStructuredConsoleLog({
      level: 'error',
      message: 'telemetry.cloudflare',
      record: {
        errorType: errorType(failure),
        event: eventName(context?.tags?.event, 'exception.captured'),
      },
    });
  },
  currentCorrelation: () => ({}),
  emitLog: (record) => {
    writeStructuredConsoleLog({
      level: record.level,
      message: 'telemetry.cloudflare',
      record: {
        attributes: compactAttributes(record.attributes),
        direction: record.direction,
        event: eventName(record.event, 'application.log'),
      },
    });
  },
  forceFlush: () => Promise.resolve(),
  recordMetric: (input) => {
    if (!analytics || !Number.isFinite(input.value)) return;
    const name = SAFE_METRIC_NAMES.has(input.name)
      ? input.name
      : input.type === 'counter'
        ? 'application.counter'
        : 'application.histogram';
    analytics.writeDataPoint({
      blobs: [
        input.type ?? 'histogram',
        JSON.stringify(compactAttributes(input.attributes)),
      ],
      doubles: [input.value],
      indexes: [name],
    });
  },
  setUser: () => {},
  startManualSpan: (options) => {
    const span = tracing.startSpan(spanName(options));
    span.setAttributes(compactAttributes(options.attributes));
    return spanHandle(span);
  },
  startSpan: (options, work) =>
    tracing.enterSpan(spanName(options), (span) => {
      span.setAttributes(compactAttributes(options.attributes));
      try {
        const result = work();
        if (isPromiseLike(result)) {
          return Promise.resolve(result).catch((failure: unknown) => {
            span.setAttribute('error.type', errorType(failure));
            throw failure;
          }) as typeof result;
        }
        return result;
      } catch (failure) {
        span.setAttribute('error.type', errorType(failure));
        throw failure;
      }
    }),
});
