import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import {
  assertDatabaseUrlTls,
  assertSecureUrlInProduction,
  isLocalhostUrl,
} from '@/modules/kernel/infrastructure/config/url-security';

const PROD = { NODE_ENV: 'production' };
const DEV = { NODE_ENV: 'development' };

describe('isLocalhostUrl', () => {
  it('detects loopback hosts across schemes', () => {
    expect(isLocalhostUrl('http://localhost:3000')).toBe(true);
    expect(isLocalhostUrl('http://127.0.0.1:9000/default')).toBe(true);
    expect(isLocalhostUrl('http://[::1]:4318/v1')).toBe(true);
    expect(isLocalhostUrl('postgres://user@localhost:5432/app')).toBe(true);
  });

  it('returns false for remote hosts and malformed URLs', () => {
    expect(isLocalhostUrl('https://example.com')).toBe(false);
    expect(isLocalhostUrl('postgres://user@db.example.com/app')).toBe(false);
    expect(isLocalhostUrl('not-a-url')).toBe(false);
  });
});

describe('assertSecureUrlInProduction', () => {
  it('rejects cleartext production URLs for remote hosts', () => {
    expect(() =>
      assertSecureUrlInProduction({
        name: 'SENTRY_DSN',
        value: 'http://sentry.example.com/1',
        env: PROD,
      })
    ).toThrow(ConfigurationError);
  });

  it('allows https, localhost, absent values, and non-production', () => {
    expect(() =>
      assertSecureUrlInProduction({
        name: 'X',
        value: 'https://example.com',
        env: PROD,
      })
    ).not.toThrow();
    expect(() =>
      assertSecureUrlInProduction({
        name: 'X',
        value: 'http://localhost:1234',
        env: PROD,
      })
    ).not.toThrow();
    expect(() =>
      assertSecureUrlInProduction({ name: 'X', value: undefined, env: PROD })
    ).not.toThrow();
    expect(() =>
      assertSecureUrlInProduction({
        name: 'X',
        value: 'http://example.com',
        env: DEV,
      })
    ).not.toThrow();
  });
});

describe('assertDatabaseUrlTls', () => {
  const remote = (query = '') =>
    `postgres://user@db.example.com:5432/app${query ? `?${query}` : ''}`;

  it.each([
    'host=attacker.example.com',
    'HOST=attacker.example.com',
    'hostaddr=203.0.113.10',
    'port=6432',
    'ssl=true',
    'sslmode=verify-full',
    'sslcert=client.pem',
    'sslkey=client.key',
    'sslrootcert=ca.pem',
    'sslpassword=secret',
    'sslnegotiation=direct',
    'uselibpqcompat=true',
  ])('rejects adapter-policy override parameter %s', (query) => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: remote(query),
        driver: 'node-pg',
        env: PROD,
        policy: 'verify',
      })
    ).toThrow(ConfigurationError);
  });

  it('uses neutral remediation for programmatic URL parameters', () => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'database client URL',
        url: remote('sslmode=require'),
        driver: 'node-pg',
        env: PROD,
        policy: 'verify',
      })
    ).toThrow(
      'remove those parameters, keep the endpoint in the URL authority, and configure TLS with the caller-provided policy.'
    );
  });

  it.each(['encrypt', 'verify'] as const)(
    'accepts an override-free production node-pg URL with the %s policy',
    (policy) => {
      expect(() =>
        assertDatabaseUrlTls({
          name: 'DATABASE_URL',
          url: remote(),
          driver: 'node-pg',
          env: PROD,
          policy,
        })
      ).not.toThrow();
    }
  );

  it('rejects an override-free remote production URL with TLS off', () => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: remote(),
        driver: 'node-pg',
        env: PROD,
        policy: 'off',
      })
    ).toThrow(ConfigurationError);
  });

  it('keeps defensive off-policy remediation neutral when given an env-style label', () => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_MIGRATION_URL',
        url: remote(),
        driver: 'node-pg',
        env: PROD,
        policy: 'off',
        policyOverrideName: 'DATABASE_MIGRATION_TLS_POLICY',
      })
    ).toThrow(
      "DATABASE_MIGRATION_URL must not use TLS policy 'off' for a remote database; select a 'verify' policy or target a loopback endpoint."
    );
  });

  it('does not conflate URL-parameter removal with a policy override', () => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: remote('sslmode=require'),
        driver: 'node-pg',
        env: PROD,
        policy: 'verify',
        policyOverrideName: 'DATABASE_MIGRATION_TLS_POLICY',
        urlOwnerPolicyName: 'DATABASE_TLS_POLICY',
      })
    ).toThrow(
      'remove those parameters, keep the endpoint in the URL authority, and configure runtime TLS with DATABASE_TLS_POLICY and migration TLS with DATABASE_MIGRATION_TLS_POLICY.'
    );
  });

  describe('Neon owns its production transport', () => {
    it.each(['neon-http', 'neon-websocket'])(
      'requires verify policy for %s in production',
      (driver) => {
        expect(() =>
          assertDatabaseUrlTls({
            name: 'DATABASE_URL',
            url: remote(),
            driver,
            env: PROD,
            policy: 'verify',
          })
        ).not.toThrow();
        expect(() =>
          assertDatabaseUrlTls({
            name: 'DATABASE_URL',
            url: remote(),
            driver,
            env: PROD,
            policy: 'encrypt',
          })
        ).toThrow(ConfigurationError);
      }
    );

    it('recommends the migration policy for an inherited Neon policy', () => {
      expect(() =>
        assertDatabaseUrlTls({
          name: 'DATABASE_MIGRATION_URL',
          url: remote(),
          driver: 'neon-websocket',
          env: PROD,
          policy: 'encrypt',
          policyOverrideName: 'DATABASE_MIGRATION_TLS_POLICY',
        })
      ).toThrow(
        'DATABASE_MIGRATION_URL uses a Neon adapter that owns secure transport; production requires DATABASE_MIGRATION_TLS_POLICY=verify.'
      );
    });

    it('uses a neutral policy name for a programmatic Neon policy', () => {
      expect(() =>
        assertDatabaseUrlTls({
          name: 'database client URL',
          url: remote(),
          driver: 'neon-websocket',
          env: PROD,
          policy: 'encrypt',
        })
      ).toThrow(
        "database client URL uses a Neon adapter that owns secure transport; production requires TLS policy 'verify'."
      );
    });
  });

  it('rejects cleartext http:// / ws:// schemes for node-pg too', () => {
    for (const url of [
      'http://db.example.com/app',
      'ws://db.example.com/app',
    ]) {
      expect(() =>
        assertDatabaseUrlTls({
          name: 'DATABASE_URL',
          url,
          driver: 'node-pg',
          env: PROD,
          policy: 'verify',
        })
      ).toThrow(ConfigurationError);
    }
  });

  it('allows off only for loopback endpoints in every environment', () => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: 'postgres://user@localhost:5432/app',
        driver: 'node-pg',
        env: PROD,
        policy: 'off',
      })
    ).not.toThrow();
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: remote(),
        driver: 'node-pg',
        env: DEV,
        policy: 'off',
      })
    ).toThrow(ConfigurationError);
  });

  it('rejects non-PostgreSQL URL schemes in every environment', () => {
    expect(() =>
      assertDatabaseUrlTls({
        name: 'DATABASE_URL',
        url: 'https://db.example.com/app',
        driver: 'node-pg',
        env: DEV,
        policy: 'off',
      })
    ).toThrow(ConfigurationError);
  });
});
