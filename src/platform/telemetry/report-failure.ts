const SAFE_ERROR_TYPES = new Set([
  'AggregateError',
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError',
]);

export const safeTelemetryErrorTypeName = (value: unknown): string =>
  typeof value === 'string' && SAFE_ERROR_TYPES.has(value) ? value : 'Error';

export const safeTelemetryFailureType = (failure: unknown): string => {
  try {
    if (failure instanceof Error) {
      const name: unknown = failure.name;
      return safeTelemetryErrorTypeName(name);
    }

    return failure === null ? 'null' : typeof failure;
  } catch {
    return 'uninspectable';
  }
};

/**
 * Last-resort diagnostic for failures in report-only telemetry paths.
 *
 * The reporter deliberately excludes error messages and values because they
 * can contain credentials or user data. It must also remain safe when handed
 * hostile values or when the console implementation itself throws.
 */
export const reportTelemetryFailure = (
  source: string,
  failure: unknown
): void => {
  try {
    const consoleLike = globalThis.console;
    const report = consoleLike?.error;
    if (typeof report !== 'function') return;

    report.call(consoleLike, 'telemetry.report_failure', {
      errorType: safeTelemetryFailureType(failure),
      source,
    });
  } catch {
    // There is intentionally no deeper reporting layer.
  }
};
