import os from 'node:os';

export class RuntimeVerificationChildError extends Error {
  constructor(message, { exitCode, signal }) {
    super(message);
    this.name = 'RuntimeVerificationChildError';
    this.exitCode = exitCode;
    this.signal = signal;
  }
}

export const runtimeVerificationFailureExitCode = (error) => {
  if (Number.isInteger(error?.exitCode) && error.exitCode > 0) {
    return error.exitCode;
  }
  if (Number.isInteger(error?.status) && error.status > 0) {
    return error.status;
  }
  const signalNumber = error?.signal
    ? os.constants.signals[error.signal]
    : undefined;
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
};

const runtimeVerificationErrorMessages = (error, seen) => {
  if (error && typeof error === 'object') {
    if (seen.has(error)) return [];
    seen.add(error);
  }
  const message = error instanceof Error ? error.message : String(error);
  const nested =
    error instanceof AggregateError
      ? [...error.errors, ...(error.cause === undefined ? [] : [error.cause])]
      : error instanceof Error && error.cause !== undefined
        ? [error.cause]
        : [];
  return [
    message,
    ...nested.flatMap((cause) => runtimeVerificationErrorMessages(cause, seen)),
  ];
};

export const formatRuntimeVerificationError = (error) =>
  runtimeVerificationErrorMessages(error, new Set()).filter(Boolean).join('\n');

export const writeRuntimeVerificationStderr = (
  message,
  { stream = process.stderr, timeoutMs = 1_000 } = {}
) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (written) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      stream.off('error', onError);
      // oxlint-disable-next-line promise/no-multiple-resolved -- The settled guard arbitrates callback, error, and timeout completion.
      resolve(written);
    };
    const onError = () => finish(false);
    const timeout = setTimeout(() => finish(false), timeoutMs);
    stream.once('error', onError);
    try {
      stream.write(`${message}\n`, (error) => finish(error === undefined));
    } catch {
      finish(false);
    }
  });

export const settleRuntimeVerificationWithin = (
  completion,
  timeoutMs = 1_000
) =>
  new Promise((resolve) => {
    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // oxlint-disable-next-line promise/no-multiple-resolved -- The settled guard arbitrates completion, rejection, and timeout.
      resolve(outcome);
    };
    const timeout = setTimeout(
      () => finish({ status: 'timed-out' }),
      Math.max(0, timeoutMs)
    );
    Promise.resolve(completion)
      .then((value) => finish({ status: 'fulfilled', value }))
      .catch((reason) => finish({ reason, status: 'rejected' }));
  });

export const normalizeRuntimeVerificationError = (reason, message) =>
  reason instanceof Error ? reason : new Error(`${message}: ${String(reason)}`);

export const runtimeVerificationErrorIsSignalCollateral = (
  error,
  signal,
  seen = new Set()
) => {
  if (!error || seen.has(error)) return false;
  const nextSeen = new Set(seen).add(error);
  const nested = [
    ...(error instanceof AggregateError ? error.errors : []),
    ...(error.cause !== undefined ? [error.cause] : []),
  ];
  if (nested.length === 0) {
    return error.signal === signal || error.signal === 'SIGKILL';
  }
  return nested.every((cause) =>
    runtimeVerificationErrorIsSignalCollateral(cause, signal, nextSeen)
  );
};

export const exitedVerificationChildError = (child, message) => {
  if (child.exitCode === null && child.signalCode === null) return undefined;
  return new RuntimeVerificationChildError(
    `${message} (${
      child.exitCode === null
        ? `signal ${child.signalCode}`
        : `exit ${child.exitCode}`
    })`,
    { exitCode: child.exitCode, signal: child.signalCode }
  );
};

export const waitForSuccessfulChild = (child, command, args) =>
  new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new RuntimeVerificationChildError(
          `${command} ${args.join(' ')} exited with ${
            code === null ? `signal ${signal}` : `code ${code}`
          }`,
          { exitCode: code, signal }
        )
      );
    });
  });
