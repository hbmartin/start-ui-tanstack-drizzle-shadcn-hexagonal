import { sanitizeLogFields } from '@/platform/lib/redaction/sanitize-log-fields';

import {
  reportTelemetryFailure,
  type TelemetryAdapter,
  type TelemetryCorrelation,
  toTelemetryStringTags,
} from '@/platform/telemetry';

/**
 * Minimum shape both `@sentry/node` and `@sentry/react` expose. Captured here
 * so the adapter does not depend on either SDK directly — runtime entries
 * (`sentry.server.ts`, `sentry.client.ts`) construct the adapter and inject
 * the active SDK.
 */
export type SentryLike = {
  captureException: (
    error: unknown,
    context?: {
      tags?: Record<string, string>;
      extra?: Record<string, unknown>;
      fingerprint?: string[];
      level?: 'debug' | 'info' | 'warning' | 'error' | 'fatal';
    }
  ) => string;
  flush?: (timeout: number) => Promise<boolean>;
  setUser: (
    user: { id: string; email?: string; segment?: string } | null
  ) => void;
  setTag?: (key: string, value: string) => void;
  startSpan?: <T>(
    options: {
      name: string;
      op?: string;
      attributes?: Record<string, string | number | boolean | undefined>;
    },
    fn: () => T
  ) => T;
};

type SentryEventLike = {
  breadcrumbs?: unknown[];
  contexts?: Record<string, unknown>;
  event_id?: unknown;
  exception?: unknown;
  level?: unknown;
  message?: unknown;
  platform?: unknown;
  request?: unknown;
  tags?: Record<string, unknown>;
  timestamp?: unknown;
  type?: unknown;
  user?: unknown;
};

const SAFE_EXCEPTION_MESSAGE = 'Unexpected application error';
const MAX_BREADCRUMBS = 20;
const MAX_EXCEPTION_VALUES = 10;
const MAX_STACK_FRAMES = 50;
const MAX_TEXT_LENGTH = 256;
const CREDENTIAL_VALUE =
  /\b(?:bearer|basic)\s+\S+|\b(?:api|pk|sk)[-_][a-zA-Z0-9_-]{6,}/giu;
const SAFE_LABEL_VALUE = /^[a-zA-Z0-9_.$<>:/-]{1,128}$/u;
const SAFE_REQUEST_METHOD = /^[A-Z]{1,10}$/u;
const SAFE_TAG_VALUE = /^[a-zA-Z0-9_./:$-]*$/u;
const TRACE_ID = /^[a-f0-9]{32}$/iu;
const SPAN_ID = /^[a-f0-9]{16}$/iu;
const SENTRY_TAG_KEYS = new Set([
  'attempt',
  'auth.operation',
  'auth.secondary_store',
  'correlationId',
  'event',
  'operation',
  'otel.span_id',
  'otel.trace_id',
  'provider',
  'requestId',
  'retryable',
  'role',
  'routeId',
  'source',
]);

const boundedSanitizedText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined;
  const sanitized = sanitizeLogFields({ value }).value;
  return typeof sanitized === 'string'
    ? sanitized
        .replace(CREDENTIAL_VALUE, '[REDACTED]')
        .slice(0, MAX_TEXT_LENGTH)
    : undefined;
};

const finiteNumber = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const boundedSafeLabel = (value: unknown): string | undefined => {
  const sanitized = boundedSanitizedText(value);
  return sanitized && SAFE_LABEL_VALUE.test(sanitized) ? sanitized : undefined;
};

const assignDefined = (
  target: Record<string, unknown>,
  key: string,
  value: unknown
) => {
  if (value !== undefined) target[key] = value;
};

const toRequestPathname = (url: unknown): string | undefined => {
  if (typeof url !== 'string') return undefined;

  try {
    return new URL(url, 'http://telemetry.invalid').pathname.slice(
      0,
      MAX_TEXT_LENGTH
    );
  } catch {
    return undefined;
  }
};

const sanitizeSentryRequest = (
  request: unknown
): Record<string, unknown> | undefined => {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return undefined;
  }
  const requestRecord = request as Record<string, unknown>;

  const method = boundedSanitizedText(requestRecord.method);
  return method && SAFE_REQUEST_METHOD.test(method) ? { method } : {};
};

const projectSentryFrame = (frame: unknown): Record<string, unknown> => {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) return {};
  const record = frame as Record<string, unknown>;
  const projected: Record<string, unknown> = {};

  assignDefined(projected, 'abs_path', toRequestPathname(record.abs_path));
  assignDefined(projected, 'colno', finiteNumber(record.colno));
  assignDefined(projected, 'filename', toRequestPathname(record.filename));
  assignDefined(projected, 'function', boundedSafeLabel(record.function));
  assignDefined(
    projected,
    'in_app',
    typeof record.in_app === 'boolean' ? record.in_app : undefined
  );
  assignDefined(projected, 'lineno', finiteNumber(record.lineno));
  assignDefined(projected, 'module', boundedSafeLabel(record.module));

  return projected;
};

const projectSentryMechanism = (
  mechanism: unknown
): Record<string, unknown> | undefined => {
  if (!mechanism || typeof mechanism !== 'object' || Array.isArray(mechanism)) {
    return undefined;
  }
  const record = mechanism as Record<string, unknown>;
  return {
    ...(typeof record.handled === 'boolean' ? { handled: record.handled } : {}),
    ...(typeof record.synthetic === 'boolean'
      ? { synthetic: record.synthetic }
      : {}),
    ...(boundedSafeLabel(record.type)
      ? { type: boundedSafeLabel(record.type) }
      : {}),
  };
};

const projectSentryStacktrace = (
  stacktrace: unknown
): Record<string, unknown> | undefined => {
  if (
    !stacktrace ||
    typeof stacktrace !== 'object' ||
    Array.isArray(stacktrace)
  ) {
    return undefined;
  }
  const frames = (stacktrace as Record<string, unknown>).frames;
  if (!Array.isArray(frames)) return undefined;

  return {
    frames: frames.slice(-MAX_STACK_FRAMES).map(projectSentryFrame),
  };
};

const projectSentryExceptionValue = (
  value: unknown
): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { value: SAFE_EXCEPTION_MESSAGE };
  }
  const record = value as Record<string, unknown>;
  const projected: Record<string, unknown> = {
    value: SAFE_EXCEPTION_MESSAGE,
  };

  assignDefined(
    projected,
    'mechanism',
    projectSentryMechanism(record.mechanism)
  );
  assignDefined(
    projected,
    'stacktrace',
    projectSentryStacktrace(record.stacktrace)
  );
  assignDefined(projected, 'type', boundedSafeLabel(record.type));

  return projected;
};

const projectSentryException = (exception: unknown): unknown => {
  if (!exception || typeof exception !== 'object' || Array.isArray(exception)) {
    return undefined;
  }
  const exceptionRecord = exception as Record<string, unknown>;
  if (!Array.isArray(exceptionRecord.values)) return undefined;

  return {
    values: exceptionRecord.values
      .slice(0, MAX_EXCEPTION_VALUES)
      .map(projectSentryExceptionValue),
  };
};

const sanitizeBreadcrumbs = (breadcrumbs: unknown[] | undefined) =>
  breadcrumbs?.slice(-MAX_BREADCRUMBS).map((breadcrumb) => {
    if (
      !breadcrumb ||
      typeof breadcrumb !== 'object' ||
      Array.isArray(breadcrumb)
    ) {
      return {};
    }

    const record = breadcrumb as Record<string, unknown>;
    return {
      ...(boundedSafeLabel(record.category)
        ? { category: boundedSafeLabel(record.category) }
        : {}),
      ...(boundedSafeLabel(record.level)
        ? { level: boundedSafeLabel(record.level) }
        : {}),
      ...(typeof record.timestamp === 'number'
        ? { timestamp: record.timestamp }
        : {}),
      ...(boundedSafeLabel(record.type)
        ? { type: boundedSafeLabel(record.type) }
        : {}),
    };
  });

const toStringTags = (tags: unknown): Record<string, string> | undefined => {
  if (!tags || typeof tags !== 'object' || Array.isArray(tags)) {
    return undefined;
  }

  const allowed = Object.fromEntries(
    Object.entries(tags as Record<string, unknown>).filter(([key]) =>
      SENTRY_TAG_KEYS.has(key)
    )
  );
  const sanitized = sanitizeLogFields(allowed);
  const stringTags = toTelemetryStringTags(sanitized, {
    allowEmpty: true,
  });
  if (!stringTags) return undefined;

  return Object.fromEntries(
    Object.entries(stringTags)
      .map<[string, string]>(([key, value]) => [
        key,
        value
          .replace(CREDENTIAL_VALUE, '[REDACTED]')
          .replace(/([?#]).*$/u, '')
          .slice(0, MAX_TEXT_LENGTH),
      ])
      .filter((entry): entry is [string, string] =>
        SAFE_TAG_VALUE.test(entry[1])
      )
  );
};

const optionalTraceLabel = (
  record: Record<string, unknown>,
  key: string
): Array<[string, string]> => {
  const value = boundedSafeLabel(record[key]);
  return value ? [[key, value]] : [];
};

const optionalTraceId = (
  record: Record<string, unknown>,
  key: string,
  pattern: RegExp
): Array<[string, string]> => {
  const value = boundedSafeLabel(record[key]);
  return value && pattern.test(value) ? [[key, value]] : [];
};

const projectTraceContext = (
  contexts: Record<string, unknown> | undefined
): Record<string, unknown> | undefined => {
  const trace = contexts?.trace;
  if (!trace || typeof trace !== 'object' || Array.isArray(trace)) {
    return undefined;
  }
  const record = trace as Record<string, unknown>;
  const projected = Object.fromEntries([
    ...optionalTraceLabel(record, 'op'),
    ...optionalTraceLabel(record, 'origin'),
    ...optionalTraceLabel(record, 'status'),
    ...optionalTraceId(record, 'parent_span_id', SPAN_ID),
    ...optionalTraceId(record, 'span_id', SPAN_ID),
    ...optionalTraceId(record, 'trace_id', TRACE_ID),
  ]);
  return Object.keys(projected).length ? { trace: projected } : undefined;
};

export const sanitizeSentryEvent = <TEvent>(event: TEvent): TEvent => {
  try {
    const eventLike = event as SentryEventLike;
    const contexts = projectTraceContext(eventLike.contexts);
    const exception = projectSentryException(eventLike.exception);
    const request = sanitizeSentryRequest(eventLike.request);
    const tags = toStringTags(eventLike.tags);

    return {
      ...(eventLike.breadcrumbs
        ? { breadcrumbs: sanitizeBreadcrumbs(eventLike.breadcrumbs) }
        : {}),
      ...(contexts ? { contexts } : {}),
      ...(boundedSafeLabel(eventLike.event_id)
        ? { event_id: boundedSafeLabel(eventLike.event_id) }
        : {}),
      ...(exception ? { exception } : {}),
      ...(boundedSafeLabel(eventLike.level)
        ? { level: boundedSafeLabel(eventLike.level) }
        : {}),
      ...(eventLike.message ? { message: SAFE_EXCEPTION_MESSAGE } : {}),
      ...(boundedSafeLabel(eventLike.platform)
        ? { platform: boundedSafeLabel(eventLike.platform) }
        : {}),
      ...(request ? { request } : {}),
      ...(tags ? { tags } : {}),
      ...(finiteNumber(eventLike.timestamp) !== undefined
        ? { timestamp: finiteNumber(eventLike.timestamp) }
        : {}),
      ...(boundedSafeLabel(eventLike.type)
        ? { type: boundedSafeLabel(eventLike.type) }
        : {}),
    } as unknown as TEvent;
  } catch (failure) {
    reportTelemetryFailure('sentry.before_send', failure);
    return { message: SAFE_EXCEPTION_MESSAGE } as unknown as TEvent;
  }
};

type SentryTelemetryAdapterOptions = {
  currentCorrelation?: () => TelemetryCorrelation;
};

export const createSentryTelemetryAdapter = (
  Sentry: SentryLike,
  { currentCorrelation = () => ({}) }: SentryTelemetryAdapterOptions = {}
): TelemetryAdapter => ({
  captureException: (error, context) => {
    let correlation: TelemetryCorrelation = {};
    try {
      correlation = currentCorrelation();
    } catch (failure) {
      reportTelemetryFailure('sentry.correlation', failure);
    }
    Sentry.captureException(error, {
      tags: toStringTags({
        ...context?.tags,
        ...(correlation.spanId && SPAN_ID.test(correlation.spanId)
          ? { 'otel.span_id': correlation.spanId }
          : {}),
        ...(correlation.traceId && TRACE_ID.test(correlation.traceId)
          ? { 'otel.trace_id': correlation.traceId }
          : {}),
      }),
      level: context?.level,
    });
  },
  setUser: (user) => {
    if (!user) {
      Sentry.setUser(null);
      Sentry.setTag?.('role', 'none');
      return;
    }
    Sentry.setUser({
      id: user.id,
      segment: user.role ?? undefined,
    });
    Sentry.setTag?.('role', user.role ?? 'none');
  },
  currentCorrelation: () => ({}),
  emitLog: () => {},
  forceFlush: async () => {
    if (!Sentry.flush) return;
    const flushed = await Sentry.flush(5_000);
    if (!flushed) throw new Error('Sentry flush did not complete');
  },
  recordMetric: () => {},
  startManualSpan: () => ({
    addEvent: () => {},
    end: () => {},
    setAttributes: () => {},
    setStatus: () => {},
  }),
  startSpan: (_options, fn) => fn(),
});
