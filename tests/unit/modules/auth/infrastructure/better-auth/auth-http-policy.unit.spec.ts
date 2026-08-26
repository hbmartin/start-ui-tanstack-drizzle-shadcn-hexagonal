import {
  ALLOWED_AUTH_HTTP_REQUESTS,
  createAuthHttpRequest,
  DENIED_AUTH_HTTP_REQUESTS,
} from '@tests/support/auth-http-exposure-fixtures';
import { describe, expect, it } from 'vitest';

import {
  isAllowedBetterAuthHttpRequest,
  isBlockedBetterAuthHttpRequest,
  TRUSTED_AUTH_CLIENT_IP_HEADER,
  withTrustedAuthClientIp,
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

  it('copies guarded runtime request headers only after cloning', async () => {
    const backingRequest = new Request(
      'http://localhost/api/auth/sign-in/social',
      {
        body: JSON.stringify({ provider: 'github' }),
        headers: {
          'content-type': 'application/json',
          [TRUSTED_AUTH_CLIENT_IP_HEADER]: '198.51.100.1',
        },
        method: 'POST',
      }
    );
    const runtimeRequest = {
      clone: () => {
        const clonedRequest = backingRequest.clone();
        Object.defineProperty(clonedRequest.headers, 'delete', {
          value: () => {
            throw new TypeError('immutable request headers');
          },
        });
        return clonedRequest;
      },
      headers: backingRequest.headers,
    } as Request;

    const trusted = withTrustedAuthClientIp(runtimeRequest, {
      kind: 'trusted-proxy-chain',
      resolve: () => '203.0.113.10',
    });

    expect(trusted.headers.get(TRUSTED_AUTH_CLIENT_IP_HEADER)).toBe(
      '203.0.113.10'
    );
    expect(runtimeRequest.headers.get(TRUSTED_AUTH_CLIENT_IP_HEADER)).toBe(
      '198.51.100.1'
    );
    await expect(trusted.json()).resolves.toEqual({ provider: 'github' });
  });

  it('removes an attacker-supplied trusted client IP when the adapter resolves no identity', () => {
    const request = new Request('http://localhost/api/auth/sign-in/social', {
      body: JSON.stringify({ provider: 'github' }),
      headers: {
        'content-type': 'application/json',
        [TRUSTED_AUTH_CLIENT_IP_HEADER]: '198.51.100.1',
      },
      method: 'POST',
    });

    const trusted = withTrustedAuthClientIp(request, {
      kind: 'trusted-proxy-chain',
      resolve: () => undefined,
    });

    expect(trusted.headers.has(TRUSTED_AUTH_CLIENT_IP_HEADER)).toBe(false);
    expect(request.headers.get(TRUSTED_AUTH_CLIENT_IP_HEADER)).toBe(
      '198.51.100.1'
    );
  });
});
