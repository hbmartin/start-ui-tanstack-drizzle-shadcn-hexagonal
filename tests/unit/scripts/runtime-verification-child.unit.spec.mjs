import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  exitedVerificationChildError,
  formatRuntimeVerificationError,
  normalizeRuntimeVerificationError,
  runtimeVerificationFailureExitCode,
  runtimeVerificationErrorIsSignalCollateral,
  settleRuntimeVerificationWithin,
  waitForSuccessfulChild,
  writeRuntimeVerificationStderr,
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

  it('renders every nested verification failure without duplicate messages', () => {
    const root = new Error('verification failed');
    const cleanup = new Error('cleanup failed', { cause: root });
    const combined = new AggregateError(
      [root, cleanup],
      'verification and cleanup failed'
    );

    expect(formatRuntimeVerificationError(combined)).toBe(
      [
        'verification and cleanup failed',
        'verification failed',
        'cleanup failed',
      ].join('\n')
    );
  });

  it('retains distinct failures that share the same message', () => {
    const combined = new AggregateError(
      [new Error('kill failed'), new Error('kill failed')],
      'both attempts failed'
    );

    expect(formatRuntimeVerificationError(combined)).toBe(
      ['both attempts failed', 'kill failed', 'kill failed'].join('\n')
    );
  });

  it('renders an AggregateError cause and terminates cause cycles', () => {
    const first = new Error('first');
    const second = new Error('second', { cause: first });
    first.cause = second;
    const combined = new AggregateError([first], 'aggregate', {
      cause: new Error('aggregate cause'),
    });

    expect(formatRuntimeVerificationError(combined)).toBe(
      ['aggregate', 'first', 'second', 'aggregate cause'].join('\n')
    );
  });

  it('bounds stderr drains and reports write failures as incomplete', async () => {
    const stalled = Object.assign(new EventEmitter(), {
      write: vi.fn(),
    });
    const failed = Object.assign(new EventEmitter(), {
      write: vi.fn((_message, callback) => callback(new Error('EPIPE'))),
    });

    await expect(
      writeRuntimeVerificationStderr('diagnostic', {
        stream: stalled,
        timeoutMs: 1,
      })
    ).resolves.toBe(false);
    await expect(
      writeRuntimeVerificationStderr('diagnostic', {
        stream: failed,
        timeoutMs: 10,
      })
    ).resolves.toBe(false);
  });

  it('reports a completed stderr drain', async () => {
    const stream = Object.assign(new EventEmitter(), {
      write: vi.fn((_message, callback) => callback()),
    });

    await expect(
      writeRuntimeVerificationStderr('diagnostic', {
        stream,
        timeoutMs: 10,
      })
    ).resolves.toBe(true);
  });

  it('reports stream errors and synchronous write throws as incomplete', async () => {
    const emittedError = Object.assign(new EventEmitter(), {
      write: vi.fn(() =>
        queueMicrotask(() => emittedError.emit('error', new Error('EPIPE')))
      ),
    });
    const thrownError = Object.assign(new EventEmitter(), {
      write: vi.fn(() => {
        throw new Error('EPIPE');
      }),
    });

    await expect(
      writeRuntimeVerificationStderr('diagnostic', {
        stream: emittedError,
        timeoutMs: 10,
      })
    ).resolves.toBe(false);
    await expect(
      writeRuntimeVerificationStderr('diagnostic', {
        stream: thrownError,
        timeoutMs: 10,
      })
    ).resolves.toBe(false);
  });

  it('ignores a write callback that arrives after the bounded timeout', async () => {
    let completeWrite;
    const stream = Object.assign(new EventEmitter(), {
      write: vi.fn((_message, callback) => {
        completeWrite = callback;
      }),
    });

    await expect(
      writeRuntimeVerificationStderr('diagnostic', {
        stream,
        timeoutMs: 1,
      })
    ).resolves.toBe(false);
    expect(() => completeWrite()).not.toThrow();
  });

  it('bounds fulfilled, rejected, and stalled verification work', async () => {
    await expect(
      settleRuntimeVerificationWithin(Promise.resolve('done'), 10)
    ).resolves.toEqual({ status: 'fulfilled', value: 'done' });
    await expect(
      settleRuntimeVerificationWithin(Promise.reject(new Error('failed')), 10)
    ).resolves.toMatchObject({
      reason: expect.objectContaining({ message: 'failed' }),
      status: 'rejected',
    });
    await expect(
      settleRuntimeVerificationWithin(new Promise(() => undefined), 1)
    ).resolves.toEqual({ status: 'timed-out' });
  });

  it('normalizes falsy failures and identifies only signal collateral', () => {
    expect(
      normalizeRuntimeVerificationError(undefined, 'cleanup failed')
    ).toEqual(
      expect.objectContaining({ message: 'cleanup failed: undefined' })
    );
    expect(
      runtimeVerificationErrorIsSignalCollateral(
        Object.assign(new Error('child stopped'), { signal: 'SIGTERM' }),
        'SIGTERM'
      )
    ).toBe(true);
    expect(
      runtimeVerificationErrorIsSignalCollateral(
        new AggregateError(
          [
            Object.assign(new Error('child stopped'), { signal: 'SIGTERM' }),
            new Error('profile failed'),
          ],
          'mixed failure'
        ),
        'SIGTERM'
      )
    ).toBe(false);
  });

  it('does not report a still-running long-lived child as failed', () => {
    expect(
      exitedVerificationChildError(
        { exitCode: null, signalCode: null },
        'application stopped'
      )
    ).toBeUndefined();
  });
});
