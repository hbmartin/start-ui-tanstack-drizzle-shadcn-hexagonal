import { EventEmitter } from 'node:events';

import { describe, expect, it } from 'vitest';

import {
  exitedVerificationChildError,
  runtimeVerificationFailureExitCode,
  waitForSuccessfulChild,
} from '../../../scripts/runtime-verification-child.mjs';

describe('runtime verification child process', () => {
  it('resolves only a zero exit code', async () => {
    const child = new EventEmitter();
    const completion = waitForSuccessfulChild(child, 'node', ['verify.mjs']);

    child.emit('exit', 0, null);

    await expect(completion).resolves.toBeUndefined();
  });

  it.each([
    [2, null, 'code 2', 2],
    [null, 'SIGTERM', 'signal SIGTERM', 143],
  ])(
    'preserves a failed child outcome',
    async (code, signal, expected, expectedExitCode) => {
      const child = new EventEmitter();
      const completion = waitForSuccessfulChild(child, 'node', ['verify.mjs']);

      child.emit('exit', code, signal);

      const error = await completion.catch((failure) => failure);
      expect(error).toMatchObject({ exitCode: code, signal });
      expect(error.message).toBe(`node verify.mjs exited with ${expected}`);
      expect(runtimeVerificationFailureExitCode(error)).toBe(expectedExitCode);
    }
  );

  it('preserves a spawn error', async () => {
    const child = new EventEmitter();
    const completion = waitForSuccessfulChild(child, 'node', ['verify.mjs']);

    child.emit('error', new Error('spawn failed'));

    const error = await completion.catch((failure) => failure);
    expect(error).toEqual(new Error('spawn failed'));
    expect(runtimeVerificationFailureExitCode(error)).toBe(1);
  });

  it.each([
    [7, null, 7, 'exit 7'],
    [0, null, 1, 'exit 0'],
    [null, 'SIGTERM', 143, 'signal SIGTERM'],
  ])(
    'preserves an already-exited long-lived child outcome',
    (exitCode, signalCode, expectedExitCode, expectedMessage) => {
      const error = exitedVerificationChildError(
        { exitCode, signalCode },
        'PGlite exited before listening'
      );

      expect(error).toMatchObject({ exitCode, signal: signalCode });
      expect(error.message).toContain(expectedMessage);
      expect(runtimeVerificationFailureExitCode(error)).toBe(expectedExitCode);
    }
  );

  it('preserves the status exposed by a synchronous child-process failure', () => {
    expect(runtimeVerificationFailureExitCode({ status: 7 })).toBe(7);
  });
});
