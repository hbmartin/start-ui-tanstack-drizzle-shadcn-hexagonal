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
