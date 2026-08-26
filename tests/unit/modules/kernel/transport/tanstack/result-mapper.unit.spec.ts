import { Result } from '@bloodyowl/boxed';
import { describe, expect, it } from 'vitest';

import {
  AppError,
  type ApplicationResult,
  type OutcomeHandlerConfig,
  ServerFnError,
  unwrapApplicationResult,
} from '@/modules/kernel/testing';

type TestOutcome =
  | { type: 'test_completed'; value: string }
  | { type: 'test_forbidden' };

describe('tanstack result mapper', () => {
  const handlers = {
    test_completed: (outcome) => outcome.value,
    test_forbidden: 'FORBIDDEN',
  } as const satisfies OutcomeHandlerConfig<TestOutcome, string>;

  it('maps successful tagged outcomes', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Ok({ type: 'test_completed' as const, value: 'value' })
        ),
        handlers
      )
    ).resolves.toBe('value');
  });

  it('maps expected business outcomes to server function errors', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(Result.Ok({ type: 'test_forbidden' as const })),
        handlers
      )
    ).rejects.toBeInstanceOf(ServerFnError);
  });

  it('maps app errors to server function errors', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Error(
            new AppError({
              code: 'USER_DUPLICATE',
              category: 'conflict',
              status: 409,
              message: 'Duplicate',
              details: { target: ['email'] },
              exposeDetails: true,
            })
          )
        ),
        handlers
      )
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      reason: 'already_exists',
      target: 'user.email',
    });
  });

  it('carries bounded retry metadata from rate-limit app errors', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Error(
            new AppError({
              code: 'RATE_LIMITED',
              category: 'rate_limit',
              status: 429,
              retryAfterSeconds: 17,
            })
          )
        ),
        handlers
      )
    ).rejects.toMatchObject({
      code: 'TOO_MANY_REQUESTS',
      reason: 'rate_limited',
      retryAfterSeconds: 17,
      status: 429,
      target: 'request',
    });
  });

  it('ignores code-specific public overrides when the category disagrees', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Error(
            new AppError({
              code: 'USER_DUPLICATE',
              category: 'bad_request',
              status: 400,
            })
          )
        ),
        handlers
      )
    ).rejects.toMatchObject({
      code: 'BAD_REQUEST',
      reason: 'invalid_input',
      status: 400,
      target: 'request',
    });
  });

  it('hides internal (system) app error messages and details from the client', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Error(
            new AppError({
              code: 'BOOK_REPOSITORY_ERROR',
              category: 'system',
              status: 500,
              message: 'connection refused: postgres://secret-host:5432',
              details: { query: 'SELECT * FROM users' },
              exposeDetails: true,
            })
          )
        ),
        handlers
      )
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      reason: 'internal_error',
      target: 'system',
    });
  });

  it('hides non-system 5xx app error messages and details from the client', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.resolve(
          Result.Error(
            new AppError({
              code: 'UPSTREAM_CONFLICT',
              category: 'conflict',
              status: 503,
              message: 'upstream conflict contained secret details',
              details: { upstream: 'internal-service' },
              exposeDetails: true,
            })
          )
        ),
        handlers
      )
    ).rejects.toMatchObject({
      code: 'INTERNAL_SERVER_ERROR',
      reason: 'internal_error',
      target: 'system',
    });
  });

  it('maps thrown app errors for legacy promise boundaries', async () => {
    await expect(
      unwrapApplicationResult(
        Promise.reject(
          new AppError({
            code: 'UNAUTHORIZED',
            category: 'unauthorized',
            status: 401,
            message: 'Unauthorized',
          })
        ) as Promise<ApplicationResult<TestOutcome>>,
        handlers
      )
    ).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      reason: 'authentication_required',
      target: 'authentication',
    });
  });

  it('never copies hostile exposed details into the public DTO', async () => {
    const failure = unwrapApplicationResult(
      Promise.resolve(
        Result.Error(
          new AppError({
            code: 'USER_DUPLICATE',
            category: 'conflict',
            status: 409,
            message: 'duplicate at db.internal?token=secret',
            details: {
              cause: { stack: 'provider stack' },
              href: 'https://internal.example/path?token=secret',
              provider: { apiKey: 'secret' },
              target: ['email', 'arbitrary-provider-field'],
            },
            exposeDetails: true,
          })
        )
      ),
      handlers
    );

    const error = await failure.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServerFnError);
    expect(JSON.stringify(error)).not.toMatch(
      /message|cause|stack|provider|href|internal\.example|db\.internal|secret/iu
    );
    expect(JSON.parse(JSON.stringify(error))).toEqual({
      correlationId: expect.any(String),
      reason: 'already_exists',
      target: 'user.email',
      version: 1,
    });
  });
});
