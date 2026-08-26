import { describe, expect, it } from 'vitest';

import {
  isPublicServerErrorDto,
  PUBLIC_SERVER_ERROR_REASONS,
  PUBLIC_SERVER_ERROR_TARGETS,
  SERVER_FN_ERROR_CODES,
  ServerFnError,
  serverFnErrorSerializationAdapter,
} from '@/modules/kernel/server';

const CORRELATION_ID = '2af28e84-fc57-4b88-a89f-a55cb53673a9';
const REASON_CODE_CASES = [
  ['invalid_input', 'BAD_REQUEST'],
  ['authentication_required', 'UNAUTHORIZED'],
  ['permission_denied', 'FORBIDDEN'],
  ['not_found', 'NOT_FOUND'],
  ['conflict', 'CONFLICT'],
  ['rate_limited', 'TOO_MANY_REQUESTS'],
  ['method_not_supported', 'METHOD_NOT_SUPPORTED'],
  ['internal_error', 'INTERNAL_SERVER_ERROR'],
  ['reauth_required', 'FORBIDDEN'],
  ['already_exists', 'CONFLICT'],
  ['self_action_forbidden', 'BAD_REQUEST'],
  ['upload_invalid', 'BAD_REQUEST'],
  ['capability_disabled', 'NOT_FOUND'],
] as const;

describe('public server-function error contract', () => {
  it.each(SERVER_FN_ERROR_CODES)(
    'serializes %s to the exact versioned public envelope',
    (code) => {
      const error = new ServerFnError(code, {
        correlationId: CORRELATION_ID,
      });

      expect(error.toJSON()).toEqual({
        correlationId: CORRELATION_ID,
        reason: expect.any(String),
        target: expect.any(String),
        version: 1,
      });
      expect(Object.keys(error.toJSON()).toSorted()).toEqual([
        'correlationId',
        'reason',
        'target',
        'version',
      ]);
      expect(PUBLIC_SERVER_ERROR_REASONS).toContain(error.reason);
      expect(PUBLIC_SERVER_ERROR_TARGETS).toContain(error.target);
    }
  );

  it('never serializes messages, causes, stacks, hosts, queries, or provider data', () => {
    const cause = new Error(
      'postgres://secret@db.internal/users?token=provider-secret'
    );
    const error = new ServerFnError('INTERNAL_SERVER_ERROR', {
      cause,
      correlationId: CORRELATION_ID,
    });
    Object.assign(error, {
      provider: { apiKey: 'provider-secret' },
      rawHref: 'https://internal.example/path?token=secret',
    });

    const serialized = JSON.stringify(error);

    expect(JSON.parse(serialized)).toEqual({
      correlationId: CORRELATION_ID,
      reason: 'internal_error',
      target: 'system',
      version: 1,
    });
    expect(serialized).not.toMatch(
      /message|cause|stack|provider|internal\.example|db\.internal|secret|query/iu
    );
  });

  it('creates distinct opaque correlation IDs when no request ID is supplied', () => {
    const first = new ServerFnError('BAD_REQUEST').toJSON();
    const second = new ServerFnError('BAD_REQUEST').toJSON();

    expect(isPublicServerErrorDto(first)).toBe(true);
    expect(isPublicServerErrorDto(second)).toBe(true);
    expect(first.correlationId).not.toBe(second.correlationId);
  });

  it('round-trips through the registered TanStack serialization adapter', () => {
    const source = new ServerFnError('CONFLICT', {
      correlationId: CORRELATION_ID,
      reason: 'already_exists',
      target: 'user.email',
    });

    const payload = serverFnErrorSerializationAdapter.toSerializable(source);
    const revived = serverFnErrorSerializationAdapter.fromSerializable(payload);

    expect(payload).toEqual({
      correlationId: CORRELATION_ID,
      reason: 'already_exists',
      target: 'user.email',
      version: 1,
    });
    expect(revived).toBeInstanceOf(ServerFnError);
    expect(revived).toMatchObject({
      code: 'CONFLICT',
      correlationId: CORRELATION_ID,
      reason: 'already_exists',
      status: 409,
      target: 'user.email',
    });
  });

  it.each(REASON_CODE_CASES)(
    'round-trips %s without changing its internal %s classification',
    (reason, code) => {
      const source = new ServerFnError(code, {
        correlationId: CORRELATION_ID,
        reason,
      });
      const revived = serverFnErrorSerializationAdapter.fromSerializable(
        serverFnErrorSerializationAdapter.toSerializable(source)
      );

      expect(revived).toMatchObject({ code, reason });
    }
  );

  it('rejects an internal code/reason mismatch before serialization', () => {
    expect(
      () =>
        new ServerFnError('FORBIDDEN', {
          reason: 'not_found',
        })
    ).toThrow('Server error reason not_found is invalid for FORBIDDEN.');
  });

  it('bounds Retry-After internally without adding it to the public DTO', () => {
    const error = new ServerFnError('TOO_MANY_REQUESTS', {
      correlationId: CORRELATION_ID,
      retryAfterSeconds: 9999,
    });

    expect(error.retryAfterSeconds).toBe(60);
    expect(error.toJSON()).toEqual({
      correlationId: CORRELATION_ID,
      reason: 'rate_limited',
      target: 'request',
      version: 1,
    });
  });

  it.each([
    {
      correlationId: CORRELATION_ID,
      reason: 'not_closed',
      target: 'request',
      version: 1,
    },
    {
      correlationId: CORRELATION_ID,
      reason: 'not_found',
      target: 'arbitrary.field',
      version: 1,
    },
    {
      correlationId: 'request-1',
      reason: 'not_found',
      target: 'request',
      version: 1,
    },
    {
      correlationId: CORRELATION_ID,
      extra: 'provider-payload',
      reason: 'not_found',
      target: 'request',
      version: 1,
    },
  ])(
    'closes hostile or open-ended adapter payloads as bad input',
    (payload) => {
      expect(isPublicServerErrorDto(payload)).toBe(false);
      const revived = serverFnErrorSerializationAdapter.fromSerializable(
        payload as never
      );

      expect(revived).toMatchObject({
        code: 'BAD_REQUEST',
        deserializationFailure: true,
        reason: 'invalid_input',
        status: 400,
        target: 'request',
      });
      expect(Object.keys(revived.toJSON()).toSorted()).toEqual([
        'correlationId',
        'reason',
        'target',
        'version',
      ]);
      expect(JSON.stringify(revived)).not.toContain('deserializationFailure');
    }
  );
});
