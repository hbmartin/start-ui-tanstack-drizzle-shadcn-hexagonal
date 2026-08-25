import { describe, expect, it } from 'vitest';
import { notFound, redirect } from '@tanstack/react-router';

import { isUnexpectedRequestFailure } from '@/platform/http/request-failure';

describe('isUnexpectedRequestFailure', () => {
  it.each([400, 401, 404, 429])(
    'classifies an HTTP %i response as expected',
    (status) => {
      expect(isUnexpectedRequestFailure(new Response(null, { status }))).toBe(
        false
      );
    }
  );

  it.each([500, 502, 503])(
    'classifies an HTTP %i response as unexpected',
    (status) => {
      expect(isUnexpectedRequestFailure(new Response(null, { status }))).toBe(
        true
      );
    }
  );

  it('handles response wrappers and hostile getters without throwing', () => {
    expect(
      isUnexpectedRequestFailure({
        response: new Response(null, { status: 409 }),
      })
    ).toBe(false);

    const failure = Object.defineProperty({}, 'response', {
      get() {
        throw new Error('hostile response getter');
      },
    });

    expect(isUnexpectedRequestFailure(failure)).toBe(true);
  });

  it('treats real TanStack redirect and not-found values as control flow', () => {
    expect(isUnexpectedRequestFailure(redirect({ to: '/login' }))).toBe(false);
    expect(isUnexpectedRequestFailure(notFound())).toBe(false);
  });
});
