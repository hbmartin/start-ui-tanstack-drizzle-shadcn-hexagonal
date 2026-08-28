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
  const signalNumber = error?.signal
    ? os.constants.signals[error.signal]
    : undefined;
  return Number.isInteger(signalNumber) ? 128 + signalNumber : 1;
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
