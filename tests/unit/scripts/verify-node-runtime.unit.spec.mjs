import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import {
  createShutdownGuard,
  createVerificationEnvironment,
  parseServerFunctionId,
  parseGeneratedCapabilityPreset,
  terminateChild,
  verifyNodeHtmlResponse,
} from '../../../scripts/verify-node-runtime.mjs';

const nonce = 'runtime-nonce';
const validResponse = () => ({
  body: `<html><body><style nonce="${nonce}">body{color:black}</style><script nonce='${nonce}'>$_TSR.e()</script></body></html>`,
  headers: new Headers({
    'content-security-policy': `default-src 'self'; script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'`,
  }),
  status: 200,
});

describe('verifyNodeHtmlResponse', () => {
  it('accepts a completed TanStack stream with matching CSP nonces', () => {
    expect(verifyNodeHtmlResponse(validResponse())).toMatchObject({
      cspNonce: nonce,
      executableTagCount: 2,
    });
  });

  it('rejects a response without the serialization end marker', () => {
    const input = validResponse();
    input.body = input.body.replace('$_TSR.e()', 'incomplete');
    expect(() => verifyNodeHtmlResponse(input)).toThrow(
      'serialization stream did not emit its end marker'
    );
  });

  it('rejects an unnonced executable tag', () => {
    const input = validResponse();
    input.body = input.body.replace(` nonce="${nonce}"`, '');
    expect(() => verifyNodeHtmlResponse(input)).toThrow(
      'script/style tag is missing a nonce'
    );
  });

  it.each([`data-nonce="${nonce}"`, `data-x="nonce='${nonce}'"`])(
    'does not treat %s as a nonce attribute',
    (hostileAttribute) => {
      const input = validResponse();
      input.body = input.body.replace(`nonce='${nonce}'`, hostileAttribute);
      expect(() => verifyNodeHtmlResponse(input)).toThrow(
        'script/style tag is missing a nonce'
      );
    }
  );

  it('rejects a nonce that differs from the CSP header', () => {
    const input = validResponse();
    input.body = input.body.replace(`nonce='${nonce}'`, "nonce='other'");
    expect(() => verifyNodeHtmlResponse(input)).toThrow(
      'does not match its CSP directive nonce'
    );
  });

  it('rejects conflicting script and style directive nonces', () => {
    const input = validResponse();
    input.headers.set(
      'content-security-policy',
      `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-other'`
    );
    expect(() => verifyNodeHtmlResponse(input)).toThrow(
      'script-src and style-src nonces do not match'
    );
  });

  it('rejects unsafe production script and style directives', () => {
    const input = validResponse();
    input.headers.set(
      'content-security-policy',
      `script-src 'self' 'unsafe-eval' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}'`
    );
    expect(() => verifyNodeHtmlResponse(input)).toThrow(
      'script-src directive is unsafe'
    );
  });
});

describe('Node verification configuration', () => {
  it('reads the requested server function ID from a built resolver', () => {
    const functionId = 'a'.repeat(64);
    const resolver = `${JSON.stringify(functionId)}: { functionName: "bookGetById_createServerFn_handler" }`;

    expect(
      parseServerFunctionId(resolver, 'bookGetById_createServerFn_handler')
    ).toBe(functionId);
    expect(parseServerFunctionId(resolver, 'missing_handler')).toBeUndefined();
  });

  it.each(['core', 'demo'])('reads the generated %s preset', (preset) => {
    expect(
      parseGeneratedCapabilityPreset(
        `export const ACTIVE_CAPABILITY_PRESET = '${preset}' as const;`
      )
    ).toBe(preset);
  });

  it('keeps object storage absent for a core verification build', () => {
    const environment = createVerificationEnvironment({
      appPort: 30_000,
      databasePort: 30_001,
      preset: 'core',
      redisPort: 30_002,
    });
    expect(environment.CAPABILITY_PRESET).toBe('core');
    expect(environment.APP_DOMAIN).toBe(
      'https://start-ui-runtime-verification.example.test'
    );
    expect(environment.VITE_BASE_URL).toBe('https://build-placeholder.invalid');
    expect(environment.GITHUB_CLIENT_ID).toBe(
      'runtime-verification-github-client-id'
    );
    expect(environment.S3_ACCESS_KEY_ID).toBeUndefined();
    expect(environment.VITE_S3_BUCKET_PUBLIC_URL).toBeUndefined();
  });

  it('configures local object storage only for a demo verification build', () => {
    const environment = createVerificationEnvironment({
      appPort: 30_000,
      databasePort: 30_001,
      preset: 'demo',
      redisPort: 30_002,
    });
    expect(environment.CAPABILITY_PRESET).toBe('demo');
    expect(environment.S3_ACCESS_KEY_ID).toBe(
      'runtime-verification-access-key'
    );
    expect(environment.VITE_S3_BUCKET_PUBLIC_URL).toMatch(
      /^http:\/\/127\.0\.0\.1/u
    );
  });

  it('selects the Vercel fetch database adapter for artifact verification', () => {
    const environment = createVerificationEnvironment({
      appPort: 30_000,
      databasePort: 30_001,
      preset: 'core',
      profile: 'vercel',
      redisPort: 30_002,
    });

    expect(environment.DATABASE_DRIVER).toBe('neon-http');
    expect(environment.DATABASE_TLS_POLICY).toBe('verify');
    expect(environment.DATABASE_MIGRATION_DRIVER).toBe('node-pg');
    expect(environment.DATABASE_MIGRATION_TLS_POLICY).toBe('off');
  });
});

describe('terminateChild', () => {
  it('does not signal a child that already exited by signal', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      signalCode: 'SIGTERM',
    });

    await expect(terminateChild(child)).resolves.toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('bounds both graceful and forced shutdown waits', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(),
      signalCode: null,
    });

    await expect(
      terminateChild(child, { gracefulTimeoutMs: 1, killTimeoutMs: 1 })
    ).resolves.toBe(false);
    expect(child.kill).toHaveBeenNthCalledWith(1, 'SIGTERM');
    expect(child.kill).toHaveBeenNthCalledWith(2, 'SIGKILL');
  });

  it('accepts close as proof that a child terminated', async () => {
    const child = Object.assign(new EventEmitter(), {
      exitCode: null,
      kill: vi.fn(() => {
        queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
      }),
      signalCode: null,
    });

    await expect(
      terminateChild(child, { gracefulTimeoutMs: 10, killTimeoutMs: 10 })
    ).resolves.toBe(true);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });
});

describe('createShutdownGuard', () => {
  it('rejects child creation after shutdown begins', () => {
    const guard = createShutdownGuard();
    expect(() => guard.assertCanSpawn()).not.toThrow();
    guard.requestShutdown();
    expect(() => guard.assertCanSpawn()).toThrow(
      'shutdown began before a child could start'
    );
  });
});
