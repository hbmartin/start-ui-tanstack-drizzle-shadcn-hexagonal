import { isLocalhostUrl } from './url-security';
import { ConfigurationError } from '../../domain/errors/configuration-error';

export const DATABASE_TLS_POLICIES = ['off', 'encrypt', 'verify'] as const;

export type DatabaseTlsPolicy = (typeof DATABASE_TLS_POLICIES)[number];

/**
 * Resolve the application-owned database transport policy.
 *
 * Loopback endpoints default to cleartext so PGlite and local PostgreSQL
 * remain usable. Every remote endpoint defaults to certificate and hostname
 * verification, including CLI/tooling processes without NODE_ENV. `off` is
 * loopback-only. `encrypt` is an explicit opt-down that encrypts transport but
 * disables certificate and hostname verification.
 */
export const resolveDatabaseTlsPolicy = ({
  configuredPolicy,
  url,
}: {
  configuredPolicy: DatabaseTlsPolicy | undefined;
  url: string;
}): DatabaseTlsPolicy => {
  const policy = configuredPolicy ?? (isLocalhostUrl(url) ? 'off' : 'verify');

  if (policy === 'off' && !isLocalhostUrl(url)) {
    throw new ConfigurationError(
      'DATABASE_TLS_POLICY=off is allowed only for a loopback database endpoint.'
    );
  }

  return policy;
};
