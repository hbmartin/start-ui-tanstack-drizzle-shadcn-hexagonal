import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import { resolveDatabaseTlsPolicy } from '@/modules/kernel/infrastructure/config/database-tls';

const remote = 'postgres://user@db.example.com:5432/app';
const loopback = 'postgres://user@127.0.0.1:5432/app';

describe('resolveDatabaseTlsPolicy', () => {
  it('defaults loopback endpoints to off', () => {
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: undefined,
        url: loopback,
      })
    ).toBe('off');
  });

  it('defaults every remote endpoint to certificate verification', () => {
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: undefined,
        url: remote,
      })
    ).toBe('verify');
  });

  it('allows an explicit encryption-only opt-down', () => {
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'encrypt',
        url: remote,
      })
    ).toBe('encrypt');
  });

  it('rejects off for remote endpoints in every environment', () => {
    expect(() =>
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'off',
        url: remote,
      })
    ).toThrow(ConfigurationError);
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'off',
        url: loopback,
      })
    ).toBe('off');
  });

  it('uses neutral names for a programmatic remote opt-out', () => {
    expect(() =>
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'off',
        url: remote,
      })
    ).toThrow(
      "TLS policy 'off' is allowed only for a loopback endpoint; use a 'verify' policy for this remote database."
    );
  });

  it('attributes an inherited policy and recommends its scoped override', () => {
    expect(() =>
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'off',
        policyOverrideName: 'DATABASE_MIGRATION_TLS_POLICY',
        policySourceName: 'DATABASE_TLS_POLICY',
        urlName: 'DATABASE_MIGRATION_URL',
        url: remote,
      })
    ).toThrow(
      'DATABASE_MIGRATION_URL uses DATABASE_TLS_POLICY=off, which is allowed only for a loopback endpoint; set DATABASE_MIGRATION_TLS_POLICY=verify for this remote database.'
    );
  });
});
