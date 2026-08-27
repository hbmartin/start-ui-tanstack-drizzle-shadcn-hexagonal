import { describe, expect, it } from 'vitest';

import { ConfigurationError } from '@/modules/kernel/domain/errors/configuration-error';
import { resolveDatabaseTlsPolicy } from '@/modules/kernel/infrastructure/config/database-tls';

const remote = 'postgres://user@db.example.com:5432/app';
const loopback = 'postgres://user@127.0.0.1:5432/app';

describe('resolveDatabaseTlsPolicy', () => {
  it('defaults local and test runtimes to off', () => {
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: undefined,
        env: { NODE_ENV: 'development' },
        url: remote,
      })
    ).toBe('off');
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: undefined,
        env: { NODE_ENV: 'test' },
        url: remote,
      })
    ).toBe('off');
  });

  it('defaults production to certificate verification', () => {
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: undefined,
        env: { NODE_ENV: 'production' },
        url: remote,
      })
    ).toBe('verify');
  });

  it('allows an explicit encryption-only production opt-down', () => {
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'encrypt',
        env: { NODE_ENV: 'production' },
        url: remote,
      })
    ).toBe('encrypt');
  });

  it('rejects production off for remote endpoints but permits loopback', () => {
    expect(() =>
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'off',
        env: { NODE_ENV: 'production' },
        url: remote,
      })
    ).toThrow(ConfigurationError);
    expect(
      resolveDatabaseTlsPolicy({
        configuredPolicy: 'off',
        env: { NODE_ENV: 'production' },
        url: loopback,
      })
    ).toBe('off');
  });
});
