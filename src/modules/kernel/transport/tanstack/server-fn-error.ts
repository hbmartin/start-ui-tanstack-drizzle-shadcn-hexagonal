import { createSerializationAdapter } from '@tanstack/react-router';

import { AppError } from '@/modules/kernel/domain/errors/app-error';

export const SERVER_FN_ERROR_CODES = [
  'BAD_REQUEST',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'NOT_FOUND',
  'CONFLICT',
  'METHOD_NOT_SUPPORTED',
  'TOO_MANY_REQUESTS',
  'INTERNAL_SERVER_ERROR',
] as const;

export type ServerFnErrorCode = (typeof SERVER_FN_ERROR_CODES)[number];

export const PUBLIC_SERVER_ERROR_TARGETS = [
  'request',
  'authentication',
  'authorization',
  'capability',
  'profile',
  'user',
  'user.email',
  'user.session',
  'book',
  'book.title',
  'book.cover',
  'genre',
  'system',
] as const;

export type PublicServerErrorTarget =
  (typeof PUBLIC_SERVER_ERROR_TARGETS)[number];

export const PUBLIC_SERVER_ERROR_REASONS = [
  'invalid_input',
  'authentication_required',
  'permission_denied',
  'not_found',
  'conflict',
  'rate_limited',
  'method_not_supported',
  'internal_error',
  'serialized_payload_invalid',
  'reauth_required',
  'already_exists',
  'self_action_forbidden',
  'upload_invalid',
  'capability_disabled',
] as const;

export type PublicServerErrorReason =
  (typeof PUBLIC_SERVER_ERROR_REASONS)[number];

/**
 * The complete error payload allowed to cross a TanStack server-function
 * boundary. Internal status, messages, stacks, causes, provider payloads, and
 * arbitrary details intentionally are not part of this versioned contract.
 */
export type PublicServerErrorDto = Readonly<{
  version: 1;
  target: PublicServerErrorTarget;
  reason: PublicServerErrorReason;
  correlationId: string;
}>;

const STATUS_BY_CODE: Record<ServerFnErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  METHOD_NOT_SUPPORTED: 405,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
};

const CATEGORY_BY_CODE: Record<
  ServerFnErrorCode,
  ConstructorParameters<typeof AppError>[0]['category']
> = {
  BAD_REQUEST: 'bad_request',
  UNAUTHORIZED: 'unauthorized',
  FORBIDDEN: 'forbidden',
  NOT_FOUND: 'not_found',
  CONFLICT: 'conflict',
  METHOD_NOT_SUPPORTED: 'bad_request',
  TOO_MANY_REQUESTS: 'rate_limit',
  INTERNAL_SERVER_ERROR: 'system',
};

const DEFAULT_PUBLIC_ERROR_BY_CODE = {
  BAD_REQUEST: { target: 'request', reason: 'invalid_input' },
  UNAUTHORIZED: {
    target: 'authentication',
    reason: 'authentication_required',
  },
  FORBIDDEN: { target: 'authorization', reason: 'permission_denied' },
  NOT_FOUND: { target: 'request', reason: 'not_found' },
  CONFLICT: { target: 'request', reason: 'conflict' },
  METHOD_NOT_SUPPORTED: {
    target: 'request',
    reason: 'method_not_supported',
  },
  TOO_MANY_REQUESTS: { target: 'request', reason: 'rate_limited' },
  INTERNAL_SERVER_ERROR: { target: 'system', reason: 'internal_error' },
} as const satisfies Record<
  ServerFnErrorCode,
  Readonly<{
    target: PublicServerErrorTarget;
    reason: PublicServerErrorReason;
  }>
>;

const CODE_BY_REASON = {
  invalid_input: 'BAD_REQUEST',
  authentication_required: 'UNAUTHORIZED',
  permission_denied: 'FORBIDDEN',
  not_found: 'NOT_FOUND',
  conflict: 'CONFLICT',
  rate_limited: 'TOO_MANY_REQUESTS',
  method_not_supported: 'METHOD_NOT_SUPPORTED',
  internal_error: 'INTERNAL_SERVER_ERROR',
  serialized_payload_invalid: 'BAD_REQUEST',
  reauth_required: 'FORBIDDEN',
  already_exists: 'CONFLICT',
  self_action_forbidden: 'BAD_REQUEST',
  upload_invalid: 'BAD_REQUEST',
  capability_disabled: 'NOT_FOUND',
} as const satisfies Record<PublicServerErrorReason, ServerFnErrorCode>;

const targetSet = new Set<string>(PUBLIC_SERVER_ERROR_TARGETS);
const reasonSet = new Set<string>(PUBLIC_SERVER_ERROR_REASONS);
const publicDtoKeys = ['correlationId', 'reason', 'target', 'version'] as const;
const compareCodePointStrings = (left: string, right: string) =>
  left < right ? -1 : left > right ? 1 : 0;
const opaqueCorrelationIdPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DESERIALIZATION_FAILURE_CAUSE_BRAND = Symbol(
  'start-ui.deserialization-failure-cause'
);
const MAX_CAUSE_CHAIN_DEPTH = 16;
const DEFAULT_RETRY_AFTER_SECONDS = 60;
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 60;

// Clone and mapper paths must preserve their original cause so this
// direction-neutral provenance survives without widening the public DTO.
const createDeserializationFailureCause = () => {
  const cause = new AppError({
    category: 'bad_request',
    code: 'SERIALIZED_PAYLOAD_INVALID',
    message: 'Malformed serialized server-function error payload',
    status: 400,
  });
  Object.defineProperty(cause, DESERIALIZATION_FAILURE_CAUSE_BRAND, {
    value: true,
  });
  return cause;
};

const isDeserializationFailureCause = (value: unknown) => {
  if (typeof value !== 'object' || value === null) return false;
  try {
    return (
      Object.getOwnPropertyDescriptor(
        value,
        DESERIALIZATION_FAILURE_CAUSE_BRAND
      )?.value === true
    );
  } catch {
    return false;
  }
};

const hasDeserializationFailureCause = (value: unknown) => {
  let current = value;
  const seen = new Set<object>();

  for (let depth = 0; depth < MAX_CAUSE_CHAIN_DEPTH; depth += 1) {
    if (isDeserializationFailureCause(current)) return true;
    if (!(current instanceof Error) || seen.has(current)) return false;

    seen.add(current);
    current = current.cause;
  }

  return false;
};

export const boundedServerFnRetryAfterSeconds = (value: number | undefined) =>
  Math.min(
    MAX_RETRY_AFTER_SECONDS,
    Math.max(
      MIN_RETRY_AFTER_SECONDS,
      value !== undefined && Number.isFinite(value) && value > 0
        ? Math.ceil(value)
        : DEFAULT_RETRY_AFTER_SECONDS
    )
  );

const isPublicServerErrorTarget = (
  value: unknown
): value is PublicServerErrorTarget =>
  typeof value === 'string' && targetSet.has(value);

const isPublicServerErrorReason = (
  value: unknown
): value is PublicServerErrorReason =>
  typeof value === 'string' && reasonSet.has(value);

export const isOpaquePublicCorrelationId = (value: unknown): value is string =>
  typeof value === 'string' && opaqueCorrelationIdPattern.test(value);

export const isPublicServerErrorDto = (
  value: unknown
): value is PublicServerErrorDto => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted(compareCodePointStrings);
  return (
    keys.length === publicDtoKeys.length &&
    keys.every((key, index) => key === publicDtoKeys[index]) &&
    record.version === 1 &&
    isPublicServerErrorTarget(record.target) &&
    isPublicServerErrorReason(record.reason) &&
    isOpaquePublicCorrelationId(record.correlationId)
  );
};

const createOpaqueCorrelationId = () => {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (typeof randomUUID !== 'function') {
    throw new AppError({
      category: 'system',
      code: 'CRYPTOGRAPHIC_UUID_UNAVAILABLE',
      message: 'Cryptographic UUID generation is unavailable.',
      status: 500,
    });
  }
  return randomUUID.call(globalThis.crypto);
};

const resolveCorrelationId = (value: string | undefined) =>
  isOpaquePublicCorrelationId(value) ? value : createOpaqueCorrelationId();

export type ServerFnErrorOptions = Readonly<{
  target?: PublicServerErrorTarget;
  reason?: PublicServerErrorReason;
  correlationId?: string;
  cause?: unknown;
  reported?: boolean;
  retryAfterSeconds?: number;
}>;

export class ServerFnError extends AppError {
  static readonly NAME = 'ServerFnError';

  readonly target: PublicServerErrorTarget;
  readonly reason: PublicServerErrorReason;
  readonly correlationId: string;
  readonly deserializationFailure: boolean;
  readonly reported: boolean;
  readonly retryAfterSeconds?: number;

  constructor(code: ServerFnErrorCode, options: ServerFnErrorOptions = {}) {
    const defaults = DEFAULT_PUBLIC_ERROR_BY_CODE[code];
    const target = isPublicServerErrorTarget(options.target)
      ? options.target
      : defaults.target;
    const reason = isPublicServerErrorReason(options.reason)
      ? options.reason
      : defaults.reason;
    if (CODE_BY_REASON[reason] !== code) {
      throw new TypeError(
        `Server error reason ${reason} is invalid for ${code}.`
      );
    }
    const correlationId = resolveCorrelationId(options.correlationId);

    super({
      code,
      category: CATEGORY_BY_CODE[code],
      status: STATUS_BY_CODE[code],
      message: 'Server function request failed',
      cause: options.cause,
    });
    this.name = ServerFnError.NAME;
    this.target = target;
    this.reason = reason;
    this.correlationId = correlationId;
    this.deserializationFailure = hasDeserializationFailureCause(options.cause);
    this.reported = options.reported ?? false;
    this.retryAfterSeconds =
      code === 'TOO_MANY_REQUESTS' && options.retryAfterSeconds !== undefined
        ? boundedServerFnRetryAfterSeconds(options.retryAfterSeconds)
        : undefined;
  }

  withCorrelationId(correlationId: string): ServerFnError {
    return new ServerFnError(this.code as ServerFnErrorCode, {
      target: this.target,
      reason: this.reason,
      correlationId,
      cause: this.cause,
      reported: this.reported,
      retryAfterSeconds: this.retryAfterSeconds,
    });
  }

  asReported(): ServerFnError {
    if (this.reported) return this;
    return new ServerFnError(this.code as ServerFnErrorCode, {
      target: this.target,
      reason: this.reason,
      correlationId: this.correlationId,
      cause: this.cause,
      reported: true,
      retryAfterSeconds: this.retryAfterSeconds,
    });
  }

  toJSON(): PublicServerErrorDto {
    return {
      version: 1,
      target: this.target,
      reason: this.reason,
      correlationId: this.correlationId,
    };
  }

  static fromPublicDto(value: PublicServerErrorDto): ServerFnError {
    return new ServerFnError(CODE_BY_REASON[value.reason], value);
  }
}

export function isServerFnError(
  error: unknown
): error is ServerFnError | PublicServerErrorDto {
  return error instanceof ServerFnError || isPublicServerErrorDto(error);
}

export const serverFnErrorSerializationAdapter = createSerializationAdapter<
  ServerFnError,
  PublicServerErrorDto
>({
  key: 'start-ui/server-error-v1',
  test: (value): value is ServerFnError => value instanceof ServerFnError,
  toSerializable: (value) => value.toJSON(),
  fromSerializable: (value) => {
    if (!isPublicServerErrorDto(value)) {
      // Symmetric adapters also deserialize client-authored server-function
      // arguments. Return a closed client-error sentinel rather than throwing
      // a pre-middleware 5xx for a malformed adapter tag. The API does not
      // expose direction, so the internal marker must not be treated as proof
      // of tampering; it can also represent version skew on a client.
      return new ServerFnError('BAD_REQUEST', {
        cause: createDeserializationFailureCause(),
        reason: 'serialized_payload_invalid',
        target: 'system',
      });
    }
    return ServerFnError.fromPublicDto(value);
  },
});
