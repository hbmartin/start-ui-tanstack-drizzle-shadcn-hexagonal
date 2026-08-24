import {
  ALLOWED_AUTH_HTTP_REQUESTS,
  createAuthHttpRequest,
  DENIED_AUTH_HTTP_REQUESTS,
} from '@tests/support/auth-http-exposure-fixtures';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isBlockedBetterAuthHttpRequest } from '@/modules/auth/testing';

const root = process.cwd();

describe('Better Auth HTTP exposure', () => {
  it('keeps the required authentication handshake reachable', async () => {
    for (const target of ALLOWED_AUTH_HTTP_REQUESTS) {
      expect(
        await isBlockedBetterAuthHttpRequest(createAuthHttpRequest(target))
      ).toBe(false);
    }
  });

  it('blocks every unowned provider operation without a reopening knob', async () => {
    for (const target of DENIED_AUTH_HTTP_REQUESTS) {
      expect(
        await isBlockedBetterAuthHttpRequest(createAuthHttpRequest(target))
      ).toBe(true);
    }

    const configSource = fs.readFileSync(
      path.join(root, 'src/modules/kernel/infrastructure/config/auth.ts'),
      'utf8'
    );
    const exampleEnv = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    expect(configSource).not.toContain('AUTH_ADMIN_ENDPOINTS_ENABLED');
    expect(configSource).not.toContain('AUTH_OPENAPI_ENABLED');
    expect(exampleEnv).not.toContain('AUTH_ADMIN_ENDPOINTS_ENABLED');
    expect(exampleEnv).not.toContain('AUTH_OPENAPI_ENABLED');
  });

  it('does not register Better Auth OpenAPI endpoints', () => {
    const authSource = fs.readFileSync(
      path.join(root, 'src/modules/auth/infrastructure/better-auth/auth.tsx'),
      'utf8'
    );

    expect(authSource).not.toMatch(/\bopenAPI\s*\(/u);
    expect(authSource).not.toMatch(/from 'better-auth\/plugins'/u);
  });

  it('ships public signup disabled in the client config and example env', () => {
    const clientConfig = fs.readFileSync(
      path.join(root, 'src/platform/env/config.ts'),
      'utf8'
    );
    const exampleEnv = fs.readFileSync(path.join(root, '.env.example'), 'utf8');

    expect(clientConfig).toMatch(
      /VITE_AUTH_SIGNUP_ENABLED[\s\S]*?\.prefault\('false'\)/u
    );
    expect(exampleEnv).toContain('VITE_AUTH_SIGNUP_ENABLED="false"');
  });
});
