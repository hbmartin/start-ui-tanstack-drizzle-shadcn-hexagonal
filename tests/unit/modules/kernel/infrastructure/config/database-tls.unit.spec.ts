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

  it('attributes a rejected policy to its configured source', () => {
    expect(() =>
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'off',
        policySourceName: 'DATABASE_MIGRATION_TLS_POLICY',
        url: remote,
      })
    ).toThrow('DATABASE_MIGRATION_TLS_POLICY=off');
  });
});
