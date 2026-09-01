/* oxlint-disable no-process-env */

/**
 * @vercel/otel 2.1.3 treats every non-empty OTEL_SDK_DISABLED value as true.
 * Normalize false-like values around its synchronous bootstrap so validated
 * OTel boolean semantics remain authoritative without permanently mutating the
 * process environment.
 */
export const runWithNormalizedOtelSdkEnvironment = <T>(operation: () => T) => {
  const originalValue = process.env.OTEL_SDK_DISABLED;
  if (
    originalValue === undefined ||
    originalValue.trim().toLowerCase() === 'true'
  ) {
    return operation();
  }

  delete process.env.OTEL_SDK_DISABLED;
  try {
    return operation();
  } finally {
    process.env.OTEL_SDK_DISABLED = originalValue;
  }
};
