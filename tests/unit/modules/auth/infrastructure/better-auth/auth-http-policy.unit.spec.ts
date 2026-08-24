import {
  ALLOWED_AUTH_HTTP_REQUESTS,
  createAuthHttpRequest,
  DENIED_AUTH_HTTP_REQUESTS,
} from '@tests/support/auth-http-exposure-fixtures';
import { describe, expect, it } from 'vitest';

import {
  isAllowedBetterAuthHttpRequest,
  isBlockedBetterAuthHttpRequest,
} from '@/modules/auth/infrastructure/better-auth/auth-http-exposure';

describe('Better Auth HTTP policy', () => {
  it('allows only the authentication endpoints and payloads the app uses', async () => {
    for (const target of ALLOWED_AUTH_HTTP_REQUESTS) {
      expect(
        await isAllowedBetterAuthHttpRequest(createAuthHttpRequest(target))
      ).toBe(true);
      expect(
        await isBlockedBetterAuthHttpRequest(createAuthHttpRequest(target))
      ).toBe(false);
    }
  });

  it('denies administrative, lifecycle, signup, and malformed requests', async () => {
    for (const target of DENIED_AUTH_HTTP_REQUESTS) {
      expect(
        await isAllowedBetterAuthHttpRequest(createAuthHttpRequest(target))
      ).toBe(false);
      expect(
        await isBlockedBetterAuthHttpRequest(createAuthHttpRequest(target))
      ).toBe(true);
    }
  });

  it('denies invalid, incorrectly typed, or unbounded JSON bodies', async () => {
    const consumedRequest = new Request(
      'http://localhost/api/auth/sign-in/social',
      {
        body: JSON.stringify({ provider: 'github' }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }
    );
    await consumedRequest.text();

    const requests = [
      new Request('http://localhost/api/auth/sign-in/social', {
        body: '{',
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      new Request('http://localhost/api/auth/sign-in/social', {
        body: JSON.stringify({ provider: 'github' }),
        headers: { 'content-type': 'text/plain' },
        method: 'POST',
      }),
      new Request('http://localhost/api/auth/sign-in/social', {
        body: JSON.stringify({ padding: 'x'.repeat(8 * 1024) }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      }),
      consumedRequest,
    ];

    for (const request of requests) {
      await expect(isAllowedBetterAuthHttpRequest(request)).resolves.toBe(
        false
      );
    }
  });
});
