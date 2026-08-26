export type AppErrorCategory =
  | 'bad_request'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limit'
  | 'system';

export type AppErrorDetails = Record<string, unknown>;

export const MIN_RETRY_AFTER_SECONDS = 1;
export const MAX_RETRY_AFTER_SECONDS = 60;

/**
 * Keep retry advice valid for every transport that consumes an AppError.
 * Invalid limiter output falls back to the conservative upper bound instead
 * of encouraging a tight retry loop.
 */
export const normalizeRetryAfterSeconds = (value: number | undefined) => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return MAX_RETRY_AFTER_SECONDS;
  }

  return Math.min(
    MAX_RETRY_AFTER_SECONDS,
    Math.max(MIN_RETRY_AFTER_SECONDS, Math.ceil(value))
  );
};

export type AppErrorOptions = {
  code: string;
  category: AppErrorCategory;
  status: number;
  retryAfterSeconds?: number;
  message?: string;
  details?: AppErrorDetails;
  exposeDetails?: boolean;
  cause?: unknown;
};

export class AppError extends Error {
  readonly code: string;
  readonly category: AppErrorCategory;
  readonly status: number;
  readonly retryAfterSeconds?: number;
  readonly details?: AppErrorDetails;
  readonly exposeDetails: boolean;

  constructor(options: AppErrorOptions) {
    super(options.message ?? options.code, { cause: options.cause });
    this.name = 'AppError';
    this.code = options.code;
    this.category = options.category;
    this.status = options.status;
    this.retryAfterSeconds =
      options.retryAfterSeconds === undefined
        ? undefined
        : normalizeRetryAfterSeconds(options.retryAfterSeconds);
    this.details = options.details;
    this.exposeDetails = options.exposeDetails ?? false;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
